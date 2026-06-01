import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliRunner } from '../src/ai/cli-transport.js';
import { runWatchTrends } from '../src/commands/watch-trends.js';
import type { StackJson } from '../src/types/stack.js';
import type { FeedSource } from '../src/types/trend.js';
import type { Fetcher } from '../src/utils/http.js';

const stack: StackJson = {
  schema_version: '1.0',
  scanned_at: '',
  repo: { name: 'demo', package_manager: 'npm', is_monorepo: false, workspaces: [] },
  runtime: { node_engine: null, typescript_version: null },
  items: [
    { name: 'eslint', category: 'linter', dependency_type: 'devDependencies', current_range: '^9', locked_version: '9.0.0', is_direct_dependency: true, workspace: '.', config_files: [] },
    { name: 'prettier', category: 'formatter', dependency_type: 'devDependencies', current_range: '^3', locked_version: '3.0.0', is_direct_dependency: true, workspace: '.', config_files: [] },
  ],
} as unknown as StackJson;

const sources: FeedSource[] = [
  { id: 'a', name: 'Newsletter A', url: 'https://feeds.test/a', group: 'g1', kind: 'rss' },
  { id: 'b', name: 'Newsletter B', url: 'https://feeds.test/b', group: 'g2', kind: 'rss' },
  { id: 'c', name: 'Newsletter C', url: 'https://feeds.test/c', group: 'g3', kind: 'rss' },
];

const rss = (title: string, link: string, date: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>feed</title>
<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description>${title}. Many teams discuss this.</description></item>
</channel></rss>`;

function fetcher(): Fetcher {
  const map: Record<string, string> = {
    'https://feeds.test/a': rss('Why teams adopt Biome', 'https://blog.test/a1', 'Mon, 04 May 2026 10:00:00 GMT'),
    'https://feeds.test/b': rss('Comparing Biome and ESLint', 'https://blog.test/b1', 'Tue, 05 May 2026 10:00:00 GMT'),
    'https://feeds.test/c': rss('Migrating a monorepo to Biome', 'https://blog.test/c1', 'Tue, 12 May 2026 10:00:00 GMT'),
  };
  return async (url) => {
    const body = map[url];
    if (body === undefined) throw new Error('no feed');
    return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
  };
}

// Every feed item names Biome, so this quote is always an exact substring of the shown text.
const extraction = { tools: [{ display_name: 'Biome', canonical_hint: '@biomejs/biome', evidence_quote: 'Biome' }] };

/** Fake `codex exec`: writes the extraction JSON to --output-last-message. */
function codexRunner() {
  let n = 0;
  const runner: CliRunner = async (_file, args) => {
    n += 1;
    const outPath = args[args.indexOf('--output-last-message') + 1]!;
    writeFileSync(outPath, JSON.stringify(extraction), 'utf8');
    return { stdout: 'progress noise', stderr: '', code: 0 };
  };
  return { runner, calls: () => n };
}

/** Fake `claude -p --output-format json`: the extraction JSON inside the envelope. */
function claudeRunner() {
  let n = 0;
  const runner: CliRunner = async () => {
    n += 1;
    return { stdout: JSON.stringify({ result: JSON.stringify(extraction), usage: {} }), stderr: '', code: 0 };
  };
  return { runner, calls: () => n };
}

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-watchcli-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack));
  return dir;
}

afterEach(() => vi.unstubAllEnvs());

describe('runWatchTrends with a CLI backend', () => {
  it('codex-cli extracts offline via the injected runner (no key) and promotes Biome to a Signal', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ''); // prove the api-key check is skipped for CLI backends
    const dir = setup();
    const { runner, calls } = codexRunner();
    await runWatchTrends({ repo: dir, asOf: '2026-06-01', now: '2026-05-20', sources, fetcher: fetcher(), aiBackend: 'codex-cli', cliRunner: runner, out: join(dir, 'wl.md') });

    const md = readFileSync(join(dir, 'wl.md'), 'utf8');
    expect(calls()).toBe(3); // one call per feed item, fan-out kept at 1
    expect(md).toMatch(/## 🚨 Signals[\s\S]*### Biome/);
    expect(md).toContain('Relates to your stack: eslint, prettier');
    expect(md).toContain('Backend: codex-cli');
    expect(md).toContain('not reported by the codex CLI');
    const trends = JSON.parse(readFileSync(join(dir, '.stack-radar', 'trends.json'), 'utf8'));
    expect(trends.mentions).toHaveLength(3);
  });

  it('claude-cli also extracts offline and records the mentions', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const dir = setup();
    const { runner, calls } = claudeRunner();
    await runWatchTrends({ repo: dir, asOf: '2026-06-01', now: '2026-05-20', sources, fetcher: fetcher(), aiBackend: 'claude-cli', cliRunner: runner, out: join(dir, 'wl.md') });

    expect(calls()).toBe(3);
    const trends = JSON.parse(readFileSync(join(dir, '.stack-radar', 'trends.json'), 'utf8'));
    expect(trends.mentions).toHaveLength(3);
  });
});
