import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliRunner } from '../src/ai/cli-transport.js';
import { runRecommend } from '../src/commands/recommend.js';
import type { Relevance } from '../src/types/relevance.js';
import type { StackJson } from '../src/types/stack.js';
import { type UpdateRecord, emptyRequirements, emptySignals } from '../src/types/update.js';

const stack: StackJson = {
  schema_version: '1.0',
  scanned_at: '',
  repo: { name: 'demo', package_manager: 'npm', is_monorepo: false, workspaces: [] },
  runtime: { node_engine: null, typescript_version: null },
  items: [],
};

function rec(name: string, over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    name,
    instances: [{ workspace: '.', current_range: '^1', dependency_type: 'dependencies' }],
    locked_version: '1.0.0',
    latest_version: '2.0.0',
    update_type: 'major',
    release_notes: [{ version: '2.0.0', url: 'https://gh/2', source: 'github_release', confidence: 'high', text: 'BREAKING: removed foo()' }],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status: 'ok',
    ...over,
  };
}

function setup(updates: UpdateRecord[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-reccli-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack));
  writeFileSync(join(dir, '.stack-radar', 'updates.json'), JSON.stringify(updates));
  return dir;
}

// Offline relevance searcher so mentioned_apis never trigger a real ripgrep subprocess.
const fakeSearcher = {
  search: async (_repo: string, apis: string[]): Promise<Relevance> => ({
    scanned: true,
    mentioned: apis.length,
    capped: false,
    apis: apis.map((a) => ({ api: a, match_count: 1, file_count: 1 })),
    total_matches: apis.length,
  }),
};

/** A valid AiEvidence (grounded quote/url) carrying a distinctive summary token. */
function evidence(summary: string) {
  return {
    package: 'pkg',
    summary,
    evidence: [{ version: '2.0.0', type: 'breaking', quote: 'BREAKING: removed foo()', url: 'https://gh/2' }],
    extracted_signals: { security_related: false, breaking_changes: ['removed foo()'], deprecations: [], bugfixes: [], performance_improvements: [], new_features: [] },
    mentioned_apis: ['foo'],
    evidence_quality: 'high',
    caveats: [],
  };
}

const usage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** Fake `claude -p --output-format json`: the {result,usage} envelope on stdout. */
function claudeRunner(summary: string) {
  let n = 0;
  const runner: CliRunner = async () => {
    n += 1;
    return { stdout: JSON.stringify({ result: JSON.stringify(evidence(summary)), usage }), stderr: '', code: 0 };
  };
  return { runner, calls: () => n };
}

/** Fake `codex exec`: writes the final message to the --output-last-message file. */
function codexRunner(summary: string) {
  let n = 0;
  const runner: CliRunner = async (_file, args) => {
    n += 1;
    const outPath = args[args.indexOf('--output-last-message') + 1]!;
    writeFileSync(outPath, JSON.stringify(evidence(summary)), 'utf8');
    return { stdout: 'progress noise', stderr: '', code: 0 };
  };
  return { runner, calls: () => n };
}

const throwingRunner: CliRunner = async () => {
  throw new Error('cliRunner must not be called — should be served from cache');
};

afterEach(() => vi.unstubAllEnvs());

describe('runRecommend --use-ai with a CLI backend', () => {
  it('claude-cli runs offline via the injected runner and needs no ANTHROPIC_API_KEY', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ''); // prove the api-key check is skipped for CLI backends
    const dir = setup([rec('pkg')]);
    const { runner, calls } = claudeRunner('via-claude-cli removes foo().');
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiBackend: 'claude-cli', cliRunner: runner, searcher: fakeSearcher, out: join(dir, 'r.md') });
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    expect(calls()).toBe(1);
    expect(md).toContain('via-claude-cli'); // AI summary from the CLI flowed into the report
    expect(md).toContain('"BREAKING: removed foo()"'); // grounded quote survived validateEvidence
    expect(md).toContain('backend: claude-cli'); // honest backend label in the appendix
    expect(md).toContain('11 input / 7 output'); // claude CLI surfaces token usage
  });

  it('isolates backends in the cache: codex is not served the claude entry, and a cached claude re-run never spawns the CLI', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const dir = setup([rec('pkg')]);

    // A: populate the claude-cli cache.
    const a = claudeRunner('FROM-CLAUDE removes foo().');
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiBackend: 'claude-cli', cliRunner: a.runner, searcher: fakeSearcher, out: join(dir, 'a.md') });
    expect(a.calls()).toBe(1);
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toContain('FROM-CLAUDE');

    // B: same repo/cache, codex backend → distinct key, so it actually runs (no cross-backend hit).
    const b = codexRunner('FROM-CODEX removes foo().');
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiBackend: 'codex-cli', cliRunner: b.runner, searcher: fakeSearcher, out: join(dir, 'b.md') });
    expect(b.calls()).toBe(1);
    const bmd = readFileSync(join(dir, 'b.md'), 'utf8');
    expect(bmd).toContain('FROM-CODEX');
    expect(bmd).not.toContain('FROM-CLAUDE');
    expect(bmd).toContain('backend: codex-cli');
    expect(bmd).toContain('not reported by the codex CLI'); // honest about missing token counts

    // C: claude-cli again → served from cache; the CLI is never invoked.
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiBackend: 'claude-cli', cliRunner: throwingRunner, searcher: fakeSearcher, out: join(dir, 'c.md') });
    expect(readFileSync(join(dir, 'c.md'), 'utf8')).toContain('FROM-CLAUDE');
  });
});
