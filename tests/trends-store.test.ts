import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrendError, loadTrendStore, parseTrendsFile } from '../src/trends/store.js';
import type { TrendMention } from '../src/types/trend.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-trend-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  return dir;
}

function m(over: Partial<TrendMention> = {}): TrendMention {
  return {
    tool_key: 'biome',
    display_name: 'Biome',
    source_id: 's1',
    source_group: 'g1',
    item_key: 'k1',
    item_url: 'https://example.com/1',
    title: 'Biome is great',
    published_at: '2026-05-01',
    observed_at: '2026-05-01',
    ...over,
  };
}

describe('JsonTrendStore', () => {
  it('records new mentions and skips duplicate (tool, source, item), preserving the first observed_at', () => {
    const dir = repo();
    const store = loadTrendStore(dir);
    expect(store.recordMentions([m(), m({ item_key: 'k2', item_url: 'https://example.com/2' })])).toBe(2);

    // Same identity, different observed_at → not added, original row preserved.
    expect(store.recordMentions([m({ observed_at: '2026-09-09' })])).toBe(0);

    const reloaded = loadTrendStore(dir).mentions();
    expect(reloaded).toHaveLength(2);
    expect(reloaded.find((x) => x.item_key === 'k1')?.observed_at).toBe('2026-05-01');
  });

  it('stores the same story from two feeds in the same publisher group as two rows', () => {
    const dir = repo();
    const store = loadTrendStore(dir);
    const added = store.recordMentions([
      m({ source_id: 'github-trending-js', source_group: 'github-trending', item_key: 'js' }),
      m({ source_id: 'github-trending-ts', source_group: 'github-trending', item_key: 'ts' }),
    ]);
    expect(added).toBe(2); // distinct source_id/item_key → two rows (aggregation collapses the group)
  });

  it('returns an empty store when none exists', () => {
    expect(loadTrendStore(repo()).mentions()).toEqual([]);
  });

  it('throws on a present-but-malformed file (never silently empty)', () => {
    const dir = repo();
    writeFileSync(join(dir, '.stack-radar', 'trends.json'), '{ not json', 'utf8');
    expect(() => loadTrendStore(dir)).toThrow(TrendError);
  });
});

describe('parseTrendsFile', () => {
  it('rejects a bad version, a non-array mentions, and a malformed mention', () => {
    expect(() => parseTrendsFile({ version: 2, mentions: [] })).toThrow(/version must be 1/);
    expect(() => parseTrendsFile({ version: 1, mentions: {} })).toThrow(/must be an array/);
    expect(() => parseTrendsFile({ version: 1, mentions: [{ display_name: 'x' }] })).toThrow(/tool_key/);
    expect(() => parseTrendsFile({ version: 1, mentions: [{ ...m(), published_at: 5 }] })).toThrow(/published_at/);
  });

  it('accepts a valid file and a null published_at', () => {
    const file = parseTrendsFile({ version: 1, mentions: [m({ published_at: null })] });
    expect(file.mentions[0]?.published_at).toBeNull();
  });
});
