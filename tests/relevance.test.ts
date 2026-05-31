import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runScanApiUsage } from '../src/commands/scan-api-usage.js';
import { type CommandRunner, MAX_APIS, createApiSearcher, normalizeApis } from '../src/relevance/searcher.js';

describe('normalizeApis', () => {
  it('keeps only plain identifiers (≥2 chars), dedupes, sorts', () => {
    const { apis, capped } = normalizeApis(['useQuery', 'useQuery', '$store', 'a.b', '1bad', 'x', 'prefetchQuery']);
    expect(apis).toEqual(['prefetchQuery', 'useQuery']); // $store, a.b, 1bad, x dropped; deduped; sorted
    expect(capped).toBe(false);
  });

  it('caps the list and flags it', () => {
    const many = Array.from({ length: MAX_APIS + 3 }, (_, i) => `api${i}`);
    const { apis, capped } = normalizeApis(many);
    expect(apis).toHaveLength(MAX_APIS);
    expect(capped).toBe(true);
  });
});

describe('createApiSearcher — Node fallback', () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sr-rel-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'useQuery();\nconst x = useQuery();\n');
    writeFileSync(join(dir, 'src', 'b.tsx'), 'import {prefetchQuery} from "q";\nuseQuery();\nprefetchQuery();\n');
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'useQuery(); useQuery(); useQuery();\n'); // must be ignored
    return dir;
  }

  it('counts matches/files across source files and ignores node_modules', async () => {
    const s = createApiSearcher({ ripgrep: false });
    const r = await s.search(fixture(), ['useQuery', 'prefetchQuery', 'neverUsed']);
    const by = Object.fromEntries(r.apis.map((u) => [u.api, u]));
    expect(by.useQuery).toEqual({ api: 'useQuery', match_count: 3, file_count: 2 }); // a.ts:2 + b.tsx:1, NOT node_modules
    expect(by.prefetchQuery).toEqual({ api: 'prefetchQuery', match_count: 2, file_count: 1 });
    expect(by.neverUsed).toEqual({ api: 'neverUsed', match_count: 0, file_count: 0 });
    expect(r.scanned).toBe(true);
    expect(r.mentioned).toBe(3);
    expect(r.total_matches).toBe(5);
  });

  it('marks scanned with mentioned=0 when no API name is valid', async () => {
    const r = await createApiSearcher({ ripgrep: false }).search(fixture(), ['$x', 'a.b']);
    expect(r).toEqual({ scanned: true, mentioned: 0, capped: false, apis: [], total_matches: 0 });
  });
});

describe('createApiSearcher — ripgrep path (fake runner)', () => {
  const rg = (byApi: Record<string, { stdout: string; code: number }>): CommandRunner => async (_file, args) => {
    if (args[0] === '--version') return { stdout: 'ripgrep 15.1.0', code: 0 };
    const api = args[args.length - 2]; // [...flags, '--', api, repoPath]
    return byApi[api] ?? { stdout: '', code: 1 };
  };

  it('parses per-file counts, discards paths, and treats exit 1 as zero', async () => {
    const s = createApiSearcher({
      ripgrep: true,
      runner: rg({ useQuery: { stdout: '/repo/src/a.ts:2\n/repo/src/b.tsx:1\n', code: 0 }, gone: { stdout: '', code: 1 } }),
    });
    const r = await s.search('/repo', ['useQuery', 'gone']);
    const by = Object.fromEntries(r.apis.map((u) => [u.api, u]));
    expect(by.useQuery).toEqual({ api: 'useQuery', match_count: 3, file_count: 2 });
    expect(by.gone).toEqual({ api: 'gone', match_count: 0, file_count: 0 });
    expect(r.total_matches).toBe(3);
  });

  it('returns scanned:false when ripgrep errors (exit 2)', async () => {
    const r = await createApiSearcher({ ripgrep: true, runner: async () => ({ stdout: '', code: 2 }) }).search('/repo', ['useQuery']);
    expect(r.scanned).toBe(false);
  });
});

describe('runScanApiUsage command', () => {
  it('prints per-API counts and a total (no paths)', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    try {
      const searcher = { search: async () => ({ scanned: true, mentioned: 1, capped: false, apis: [{ api: 'useQuery', match_count: 5, file_count: 2 }], total_matches: 5 }) };
      await runScanApiUsage({ repo: '.', apis: 'useQuery', package: 'react', searcher });
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('for react');
    expect(out).toContain('useQuery: 5 matches across 2 files');
    expect(out).toContain('total: 5 matches across 1 APIs');
    expect(out).not.toMatch(/\.ts|\/src\//); // no source paths
    expect(out).not.toContain(resolve('.')); // not even the repo path
  });
});
