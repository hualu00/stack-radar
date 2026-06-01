import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AiBackend, AI_BACKENDS, type TokenUsage, emptyTokenUsage } from '../types/ai.js';
import { DEFAULT_AI_MODEL } from './client.js';
import type { LlmPrompt, LlmTransport, TransportResult } from './transport.js';

/**
 * A second `LlmTransport` implementation that shells out to a LOCAL AI CLI
 * (`claude` / Claude Code, or `codex` / Codex CLI) instead of the Anthropic API.
 * It rides the CLI's own subscription login, so no `ANTHROPIC_API_KEY` is needed.
 *
 * Privacy (PLAN §14, "never send source code"): each call runs in a fresh, EMPTY
 * temp dir as cwd (never the repo), with the agentic CLI's file tools disabled
 * (claude) / a read-only sandbox (codex) and a sanitized env — so the CLI cannot
 * read repo source. Only the same public package metadata + changelog/feed text the
 * API backend sends ever crosses the boundary. The model still runs remotely.
 *
 * Determinism: the subprocess is behind an injectable `CliRunner` (mirrors
 * relevance/searcher.ts) so tests spawn nothing.
 */

// Re-exported for convenience; the canonical definitions live in ../types/ai.js.
export { AI_BACKENDS };
export type { AiBackend };

/** Validate a raw `--ai-backend` value; throws a clear error on a typo. */
export function parseBackend(value: string): AiBackend {
  if ((AI_BACKENDS as readonly string[]).includes(value)) return value as AiBackend;
  throw new Error(`invalid --ai-backend "${value}" (expected one of: ${AI_BACKENDS.join(', ')})`);
}

/** Default model for the claude-cli backend: subscription has no per-token penalty,
 * so use the strongest model. Concrete id (not the `opus` alias) keeps the cache key
 * stable; `--ai-model opus` is the always-latest override. */
export const DEFAULT_CLAUDE_CLI_MODEL = 'claude-opus-4-8';

/** Sentinel used when codex-cli runs with no explicit `--ai-model`: codex picks its
 * own configured (strongest) model, and this stable label goes into the cache key +
 * report model field instead of a misleading Claude name. */
export const CODEX_DEFAULT_LABEL = 'codex-default';

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolve the model for a backend. `--ai-model` (aiModel) always wins. The api default
 * (sonnet) is a metered-cost choice; CLI backends run under a flat-fee subscription, so
 * default them to the strongest model (claude-cli → Opus). codex-cli with no explicit
 * model gets a stable sentinel label (the adapter then omits `-m`, letting codex pick its
 * own configured model) so the cache key + report field aren't a misleading Claude name.
 */
export function resolveModel(backend: AiBackend, aiModel?: string): string {
  if (aiModel) return aiModel;
  if (backend === 'claude-cli') return DEFAULT_CLAUDE_CLI_MODEL;
  if (backend === 'codex-cli') return CODEX_DEFAULT_LABEL;
  return DEFAULT_AI_MODEL;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CliRunOptions {
  /** Text piped to the child's stdin (the prompt for both adapters). */
  stdin?: string;
  /** Working directory — ALWAYS the empty temp dir, never the repo (privacy). */
  cwd: string;
  /** Wall-clock cap; a hung agentic CLI becomes a per-record degrade, not a stuck run. */
  timeoutMs?: number;
}

/** Injectable subprocess seam — tests fake the CLI's stdout/exit code. */
export type CliRunner = (file: string, args: string[], options: CliRunOptions) => Promise<CliRunResult>;

/** Per-backend knowledge: how to build argv + stdin and parse the CLI's output. */
export interface CliAdapter {
  defaultCommand: string;
  prepare(
    prompt: LlmPrompt,
    ctx: { command: string; model: string; maxTokens: number; tmpDir: string },
  ): {
    args: string[];
    stdin?: string;
    /** Turn the run result into the model's answer text + token usage. */
    finish(result: CliRunResult): { text: string; usage: TokenUsage };
    cleanup?(): void;
  };
}

/** Build the child env from process.env but DROP repo-context leaks, keeping auth
 * essentials (PATH/HOME and the CLI's own config). Exported for unit testing. */
export function sanitizeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.PWD;
  delete env.OLDPWD;
  delete env.INIT_CWD;
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_') || key.startsWith('yarn_') || key.startsWith('BERRY_')) delete env[key];
  }
  return env;
}

const defaultCliRunner: CliRunner = (file, args, options) =>
  new Promise((resolvePromise) => {
    const child = execFile(
      file,
      args,
      {
        shell: false,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: sanitizeEnv(),
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        const rawCode = e?.code;
        // Numeric code = process exit status; a string code (ENOENT) or a timeout kill → spawn failure → -1.
        const code = typeof rawCode === 'number' ? rawCode : err ? -1 : 0;
        // Keep a distinct diagnostic for the -1 case so a timeout doesn't read like a missing binary.
        const stderrOut =
          code === -1 && e
            ? stderr || (e.killed ? `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : e.message)
            : (stderr ?? '');
        resolvePromise({ stdout: stdout ?? '', stderr: stderrOut, code });
      },
    );
    // EPIPE if the child exits before reading stdin — swallow it, the exit code tells the story.
    child.stdin?.on('error', () => {});
    if (options.stdin !== undefined) child.stdin?.write(options.stdin);
    child.stdin?.end();
  });

/** Strip a leading ```` ```json ````/```` ``` ```` fence + trailing ```` ``` ```` (claude has no native schema enforcement). */
export function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    const firstNl = t.indexOf('\n');
    if (firstNl !== -1) t = t.slice(firstNl + 1);
    if (t.endsWith('```')) t = t.slice(0, -3);
  }
  return t.trim();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function embedSchema(system: string, schema: Record<string, unknown>): string {
  return `${system}\n\nYou MUST respond with ONLY a single JSON object that conforms exactly to this JSON schema. No prose, no markdown, no code fences:\n${JSON.stringify(schema)}`;
}

function mapClaudeUsage(u: unknown): TokenUsage {
  if (!isObject(u)) return emptyTokenUsage();
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
  };
}

/** Claude Code headless: prompt on stdin, structured envelope on stdout. No native
 * schema enforcement → schema is embedded in the system prompt; file tools disabled. */
const claudeAdapter: CliAdapter = {
  defaultCommand: 'claude',
  prepare(prompt, ctx) {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      ctx.model,
      '--append-system-prompt',
      embedSchema(prompt.system, prompt.schema),
      // Allow-none posture (more robust than a denylist that future/MCP tools could slip past).
      // Paired with the empty cwd + sanitized env, this blocks repo reads. NOT `--bare` — that
      // forces ANTHROPIC_API_KEY (OAuth/keychain never read) and would defeat subscription auth.
      '--tools',
      '', // "" = disable ALL built-in tools
      '--strict-mcp-config', // ignore any configured MCP servers (we pass none)
      '--no-session-persistence', // don't write the session to disk (only works with --print)
      '--disable-slash-commands', // no skill resolution
    ];
    return {
      args,
      stdin: prompt.user, // NOT argv: avoids ARG_MAX and keeps prompt text out of `ps`
      finish(result) {
        // `--output-format json` → { result: <assistant text>, usage: {...} }.
        let envelope: unknown;
        try {
          envelope = JSON.parse(result.stdout);
        } catch {
          // Envelope itself unparseable → let the transport's outer parse decide on the raw stdout.
          return { text: result.stdout, usage: emptyTokenUsage() };
        }
        if (!isObject(envelope)) return { text: result.stdout, usage: emptyTokenUsage() };
        const text = typeof envelope.result === 'string' ? envelope.result : '';
        return { text, usage: mapClaudeUsage(envelope.usage) };
      },
    };
  },
};

/** Codex non-interactive: prompt on stdin, NATIVE schema enforcement via --output-schema,
 * final assistant message written to a file. Read-only sandbox + empty cwd blocks repo reads. */
const codexAdapter: CliAdapter = {
  defaultCommand: 'codex',
  prepare(prompt, ctx) {
    const schemaPath = join(ctx.tmpDir, 'schema.json');
    const outPath = join(ctx.tmpDir, 'out.txt');
    writeFileSync(schemaPath, JSON.stringify(prompt.schema), 'utf8');
    // Omit -m when running on codex's own default model (the sentinel label).
    const modelArgs = ctx.model && ctx.model !== CODEX_DEFAULT_LABEL ? ['-m', ctx.model] : [];
    const args = [
      'exec',
      ...modelArgs,
      '--sandbox',
      'read-only', // no writes; reads aren't OS-confined to cwd, but the model is given no repo path
      '--skip-git-repo-check',
      '--ephemeral', // don't persist session files to disk
      '-C',
      ctx.tmpDir,
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outPath,
    ];
    // NOTE: --ignore-user-config is deliberately NOT passed — it would skip config.toml where the
    // user's preferred (strongest) default model lives, which the codex-default path relies on.
    return {
      args,
      stdin: `${prompt.system}\n\n${prompt.user}`,
      finish() {
        // Codex's final-message file carries no token counts → usage unavailable (zeros).
        let text = '';
        try {
          text = readFileSync(outPath, 'utf8');
        } catch {
          text = '';
        }
        return { text, usage: emptyTokenUsage() };
      },
    };
  },
};

export const CLI_ADAPTERS: Record<Exclude<AiBackend, 'api'>, CliAdapter> = {
  'claude-cli': claudeAdapter,
  'codex-cli': codexAdapter,
};

export interface CliTransportOptions {
  adapter: CliAdapter;
  model: string;
  /** Override the binary path (--ai-command). */
  command?: string;
  /** Accepted for call-site parity with createAnthropicTransport, but intentionally UNUSED:
   * neither `claude -p` nor `codex exec` exposes a clean max-output-tokens flag. */
  maxTokens?: number;
  /** Injected in tests; defaults to a real execFile-backed runner. */
  runner?: CliRunner;
  timeoutMs?: number;
}

/**
 * Build a CLI-backed `LlmTransport`. Each `complete` runs the CLI once in a fresh
 * empty temp dir, parses the answer as JSON, and returns `{ raw, usage }`. A non-zero
 * exit OR unparseable output THROWS (a deliberate difference from the Anthropic
 * transport, which returns `raw=null`): for CLI backends — especially claude, whose
 * schema adherence is prompt-only — that is a transport failure, so the client/extractor
 * catch degrades the one record AND skips the cache write (garbage is never cached).
 */
export function createCliTransport(opts: CliTransportOptions): LlmTransport {
  const command = opts.command ?? opts.adapter.defaultCommand;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const runner = opts.runner ?? defaultCliRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async complete(prompt: LlmPrompt): Promise<TransportResult> {
      const tmpDir = mkdtempSync(join(tmpdir(), 'sr-cli-'));
      // `prepare` runs INSIDE the try so a failure there (e.g. writing the codex schema file)
      // still hits the `finally` and never leaks the temp dir.
      let cleanup: (() => void) | undefined;
      try {
        const prepared = opts.adapter.prepare(prompt, { command, model: opts.model, maxTokens, tmpDir });
        cleanup = prepared.cleanup;
        const result = await runner(command, prepared.args, { stdin: prepared.stdin, cwd: tmpDir, timeoutMs });
        if (result.code !== 0) {
          throw new Error(`${command} exited ${result.code}${result.stderr ? `: ${result.stderr.slice(0, 200).trim()}` : ''}`);
        }
        const { text, usage } = prepared.finish(result);
        let raw: unknown;
        try {
          raw = JSON.parse(stripFences(text));
        } catch {
          throw new Error(`${command} returned empty or unparseable JSON output`);
        }
        return { raw, usage };
      } finally {
        cleanup?.();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}
