import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_BACKENDS, CLI_ADAPTERS, CODEX_DEFAULT_LABEL, type CliRunOptions, type CliRunResult, createCliTransport, parseBackend, sanitizeEnv, stripFences } from '../src/ai/cli-transport.js';
import type { LlmPrompt } from '../src/ai/transport.js';

const prompt: LlmPrompt = {
  system: 'You extract tools.',
  user: 'Title: Biome 2 lands\n\nBiome now formats and lints.',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};

/** Records every invocation; lets a test assert argv/stdin/cwd and craft the result. */
function recordingRunner(handler: (file: string, args: string[], options: CliRunOptions) => CliRunResult) {
  const calls: { file: string; args: string[]; options: CliRunOptions }[] = [];
  const runner = async (file: string, args: string[], options: CliRunOptions): Promise<CliRunResult> => {
    calls.push({ file, args, options });
    return handler(file, args, options);
  };
  return { runner, calls };
}

function claudeEnvelope(resultText: string, usage?: Record<string, number>): CliRunResult {
  return { stdout: JSON.stringify({ result: resultText, usage: usage ?? {} }), stderr: '', code: 0 };
}

describe('parseBackend', () => {
  it('accepts each known backend and rejects a typo', () => {
    for (const b of AI_BACKENDS) expect(parseBackend(b)).toBe(b);
    expect(() => parseBackend('claude')).toThrow(/invalid --ai-backend "claude"/);
    expect(() => parseBackend('')).toThrow(/invalid --ai-backend/);
  });
});

describe('--ai-command override', () => {
  it('runs the given executable path instead of the adapter default', async () => {
    const { runner, calls } = recordingRunner(() => claudeEnvelope('{"ok":true}'));
    const t = createCliTransport({ adapter: CLI_ADAPTERS['claude-cli'], model: 'claude-opus-4-8', command: '/opt/my-claude', runner });
    await t.complete(prompt);
    expect(calls[0]!.file).toBe('/opt/my-claude');
  });
});

describe('stripFences', () => {
  it('strips ```json fences and plain ``` fences', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('sanitizeEnv', () => {
  it('drops repo-context vars but keeps auth essentials', () => {
    const out = sanitizeEnv({ PATH: '/bin', HOME: '/home/x', PWD: '/repo', OLDPWD: '/old', INIT_CWD: '/repo', npm_config_registry: 'x', yarn_foo: 'y', BERRY_BIN: 'z', KEEP: '1' });
    expect(out.PATH).toBe('/bin');
    expect(out.HOME).toBe('/home/x');
    expect(out.KEEP).toBe('1');
    expect(out.PWD).toBeUndefined();
    expect(out.OLDPWD).toBeUndefined();
    expect(out.INIT_CWD).toBeUndefined();
    expect(out.npm_config_registry).toBeUndefined();
    expect(out.yarn_foo).toBeUndefined();
    expect(out.BERRY_BIN).toBeUndefined();
  });
});

describe('claude-cli adapter', () => {
  it('builds headless argv with the prompt on STDIN (not argv) and a tmp cwd', async () => {
    const { runner, calls } = recordingRunner(() => claudeEnvelope('{"ok":true}', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }));
    const t = createCliTransport({ adapter: CLI_ADAPTERS['claude-cli'], model: 'claude-opus-4-8', runner });
    const res = await t.complete(prompt);

    const { file, args, options } = calls[0]!;
    expect(file).toBe('claude');
    expect(args).toContain('-p');
    // Allow-none tool posture; NOT --bare (which would force an API key).
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'json', '--model', 'claude-opus-4-8', '--append-system-prompt', '--tools', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']));
    expect(args[args.indexOf('--tools') + 1]).toBe(''); // "" disables all built-in tools
    expect(args).not.toContain('--bare');
    // The schema is embedded in the system prompt arg, NOT a flag.
    const sysArg = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sysArg).toContain('JSON schema');
    expect(sysArg).toContain('"required":["ok"]');
    // Changelog/user text rides stdin, never argv.
    expect(options.stdin).toBe(prompt.user);
    expect(args.join(' ')).not.toContain('Biome now formats');
    expect(options.cwd).toContain('sr-cli-');

    expect(res.raw).toEqual({ ok: true });
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
  });

  it('strips code fences around the answer', async () => {
    const { runner } = recordingRunner(() => claudeEnvelope('```json\n{"ok":false}\n```'));
    const t = createCliTransport({ adapter: CLI_ADAPTERS['claude-cli'], model: 'claude-opus-4-8', runner });
    expect((await t.complete(prompt)).raw).toEqual({ ok: false });
  });

  it('THROWS on an unparseable answer and still cleans up the temp dir (no garbage cached)', async () => {
    let cwd = '';
    const { runner } = recordingRunner((_f, _a, o) => {
      cwd = o.cwd;
      return claudeEnvelope('not json at all');
    });
    const t = createCliTransport({ adapter: CLI_ADAPTERS['claude-cli'], model: 'claude-opus-4-8', runner });
    await expect(t.complete(prompt)).rejects.toThrow(/unparseable JSON/);
    expect(existsSync(cwd)).toBe(false);
  });

  it('THROWS on a non-zero exit (degrades the record upstream)', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'boom', code: 1 }));
    const t = createCliTransport({ adapter: CLI_ADAPTERS['claude-cli'], model: 'claude-opus-4-8', runner });
    await expect(t.complete(prompt)).rejects.toThrow(/exited 1: boom/);
  });

  it('THROWS on a spawn failure (code -1, e.g. missing binary)', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: '', code: -1 }));
    const t = createCliTransport({ adapter: CLI_ADAPTERS['claude-cli'], model: 'claude-opus-4-8', command: 'nope', runner });
    await expect(t.complete(prompt)).rejects.toThrow(/nope exited -1/);
  });
});

describe('codex-cli adapter', () => {
  // Codex writes the final message to the --output-last-message file; the fake runner emulates that,
  // and (while the temp dir still exists) captures the schema prepare() wrote to --output-schema.
  function codexRunner(answer: string) {
    let schemaWritten: unknown;
    const rec = recordingRunner((_f, args) => {
      const schemaPath = args[args.indexOf('--output-schema') + 1]!;
      schemaWritten = JSON.parse(readFileSync(schemaPath, 'utf8'));
      const outPath = args[args.indexOf('--output-last-message') + 1]!;
      writeFileSync(outPath, answer, 'utf8');
      return { stdout: 'progress noise', stderr: '', code: 0 };
    });
    return { ...rec, schema: () => schemaWritten };
  }

  it('builds `exec` argv with --output-schema, read-only sandbox, stdin = system+user, and usage zeros', async () => {
    const { runner, calls, schema } = codexRunner('{"ok":true}');
    const t = createCliTransport({ adapter: CLI_ADAPTERS['codex-cli'], model: 'gpt-5.2-codex', runner });
    const res = await t.complete(prompt);

    const { file, args, options } = calls[0]!;
    expect(file).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.2-codex', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', '--output-schema', '--output-last-message']));
    // The schema file really gets written by prepare (captured during the run, before cleanup).
    expect(schema()).toEqual(prompt.schema);
    expect(options.stdin).toBe(`${prompt.system}\n\n${prompt.user}`);

    expect(res.raw).toEqual({ ok: true });
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  it('omits -m when running on the codex-default sentinel', async () => {
    const { runner, calls } = codexRunner('{"ok":true}');
    const t = createCliTransport({ adapter: CLI_ADAPTERS['codex-cli'], model: CODEX_DEFAULT_LABEL, runner });
    await t.complete(prompt);
    expect(calls[0]!.args).not.toContain('-m');
  });

  it('THROWS on a non-zero exit', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'sandbox denied', code: 2 }));
    const t = createCliTransport({ adapter: CLI_ADAPTERS['codex-cli'], model: CODEX_DEFAULT_LABEL, runner });
    await expect(t.complete(prompt)).rejects.toThrow(/exited 2/);
  });
});
