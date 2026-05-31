import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runWatchTrends } from '../src/commands/watch-trends.js';
import type { TrendExtractor } from '../src/trends/extract.js';
import type { StackJson } from '../src/types/stack.js';
import type { ExtractedTool, FeedSource } from '../src/types/trend.js';
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

/** Three feeds, three publisher groups, Biome across two ISO weeks + three stories. */
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

/** Fake AI: extracts "Biome" from any item mentioning it (already-validated tools). */
const biomeExtractor: TrendExtractor = {
  extract: async (item) => {
    const tools: ExtractedTool[] = /biome/i.test(`${item.title} ${item.summary}`)
      ? [{ display_name: 'Biome', canonical_hint: '@biomejs/biome', evidence_quote: 'Biome' }]
      : [];
    return { tools, usage: null, cached: false, status: 'ok' };
  },
};

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-watch-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack));
  return dir;
}

const opts = (dir: string, over = {}) => ({
  repo: dir,
  asOf: '2026-06-01',
  now: '2026-05-20',
  sources,
  fetcher: fetcher(),
  extractor: biomeExtractor,
  out: join(dir, 'wl.md'),
  ...over,
});

describe('runWatchTrends (end-to-end, injected seams)', () => {
  it('promotes a tool with independent, sustained, stack-related coverage to a Signal', async () => {
    const dir = setup();
    await runWatchTrends(opts(dir));
    const md = readFileSync(join(dir, 'wl.md'), 'utf8');
    // Legend up front, so a fresh reader can interpret Signal / Emerging / publisher group.
    expect(md).toContain('## How to read this');
    expect(md).toContain('publisher groups');
    expect(md).toContain('## 🚨 Signals');
    expect(md).toMatch(/## 🚨 Signals[\s\S]*### Biome/);
    expect(md).toContain('Relates to your stack: eslint, prettier');
    expect(md).toContain('3 publisher group(s)');
    // trends.json persisted the three mentions.
    const trends = JSON.parse(readFileSync(join(dir, '.stack-radar', 'trends.json'), 'utf8'));
    expect(trends.mentions).toHaveLength(3);
  });

  it('is idempotent + deterministic: a second run adds nothing and produces identical bytes', async () => {
    const dir = setup();
    await runWatchTrends(opts(dir, { out: join(dir, 'a.md') }));
    await runWatchTrends(opts(dir, { out: join(dir, 'b.md') }));
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(readFileSync(join(dir, 'b.md'), 'utf8'));
    // Re-running the same feeds did not duplicate mentions.
    const trends = JSON.parse(readFileSync(join(dir, '.stack-radar', 'trends.json'), 'utf8'));
    expect(trends.mentions).toHaveLength(3);
  });

  it('keeps an unrelated tool out of Signals (stack relation gate)', async () => {
    const dir = setup();
    const fooExtractor: TrendExtractor = {
      extract: async () => ({ tools: [{ display_name: 'FooLib', evidence_quote: 'x' }], usage: null, cached: false, status: 'ok' }),
    };
    await runWatchTrends(opts(dir, { extractor: fooExtractor }));
    const md = readFileSync(join(dir, 'wl.md'), 'utf8');
    expect(md).toMatch(/## 🚨 Signals\s*\n\s*\n_Tools[\s\S]*?\n\s*\n_\(none\)_/); // no signals
    expect(md).toContain('no related stack dependency');
  });

  it('warns in the watchlist when an extraction degrades (status: error)', async () => {
    const dir = setup();
    const errExtractor: TrendExtractor = {
      extract: async () => ({ tools: [], usage: null, cached: false, status: 'error' }),
    };
    await runWatchTrends(opts(dir, { extractor: errExtractor }));
    const md = readFileSync(join(dir, 'wl.md'), 'utf8');
    expect(md).toContain('could not be analyzed');
  });

  it('disables Signals with a clear notice when stack.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-watch-'));
    mkdirSync(join(dir, '.stack-radar'), { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let warned = false;
    try {
      await runWatchTrends(opts(dir)); // no stack.json written
      warned = errSpy.mock.calls.some((c) => String(c[0]).includes('no .stack-radar/stack.json'));
    } finally {
      errSpy.mockRestore(); // restore AFTER capturing — mockRestore wipes call history
      logSpy.mockRestore();
    }
    const md = readFileSync(join(dir, 'wl.md'), 'utf8');
    expect(md).toContain('Signals are disabled: no stack.json');
    expect(warned).toBe(true);
  });

  it('dry-run needs no API key, prints prompts, and records nothing', async () => {
    const dir = setup();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    try {
      // No extractor injected + dryRun → real extractor in dry-run mode (offline, no key).
      await runWatchTrends({ repo: dir, asOf: '2026-06-01', now: '2026-05-20', sources, fetcher: fetcher(), dryRun: true, out: join(dir, 'wl.md') });
    } finally {
      spy.mockRestore();
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
    const md = readFileSync(join(dir, 'wl.md'), 'utf8');
    expect(md).toContain('AI dry-run');
    expect(logs.join('\n')).toContain('TREND PROMPT:');
    // dry-run extracts nothing → no trends.json written.
    expect(() => readFileSync(join(dir, '.stack-radar', 'trends.json'), 'utf8')).toThrow();
  });
});
