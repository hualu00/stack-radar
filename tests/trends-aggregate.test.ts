import { describe, expect, it } from 'vitest';
import { aggregate, isoWeekKey } from '../src/trends/aggregate.js';
import { canonicalToolKey, relateToStack } from '../src/trends/relations.js';
import type { TrendMention } from '../src/types/trend.js';

function m(over: Partial<TrendMention> = {}): TrendMention {
  return {
    tool_key: 'biome',
    display_name: 'Biome',
    source_id: 's1',
    source_group: 'g1',
    item_key: 'k1',
    item_url: 'https://example.com/1',
    title: 'Why teams adopt Biome',
    published_at: '2026-05-04',
    observed_at: '2026-05-04',
    ...over,
  };
}

describe('canonicalToolKey', () => {
  it('maps known variants to one key and slugifies the rest', () => {
    expect(canonicalToolKey('React Query')).toBe('tanstack-react-query');
    expect(canonicalToolKey('@tanstack/react-query')).toBe('tanstack-react-query');
    expect(canonicalToolKey('Vite', 'vitejs')).toBe('vite'); // hint preferred
    expect(canonicalToolKey('Some New Tool')).toBe('some-new-tool');
    expect(canonicalToolKey('@scope/pkg')).toBe('scope-pkg');
  });
});

describe('relateToStack', () => {
  const stack = ['eslint', 'prettier', 'react', '@tanstack/react-query'];
  it('matches substitutes, in-stack tools (incl. via alias), and returns [] for the unrelated', () => {
    expect(relateToStack('biome', stack)).toEqual(['eslint', 'prettier']);
    expect(relateToStack('react', stack)).toEqual(['react']); // the tool itself is in the stack
    expect(relateToStack('tanstack-react-query', stack)).toEqual(['@tanstack/react-query']); // alias-canonicalized match
    expect(relateToStack('vite', stack)).toEqual([]); // no webpack/rspack/etc. in this stack
    expect(relateToStack('some-new-tool', stack)).toEqual([]);
  });
});

describe('isoWeekKey (UTC, ISO week-year)', () => {
  it('buckets dates straddling the new year correctly', () => {
    expect(isoWeekKey('2025-12-30')).toBe('2026-W01'); // same ISO week as Jan 1
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(isoWeekKey('2025-12-22')).toBe('2025-W52');
    expect(isoWeekKey('2026-01-05')).toBe('2026-W02');
  });
});

describe('aggregate — signal gate', () => {
  const stack = ['eslint', 'prettier'];

  // 3 publisher groups, 2 ISO weeks, 3 stories, non-release titles, related to stack.
  const signalMentions: TrendMention[] = [
    m({ source_group: 'g1', item_key: 'k1', title: 'Why teams adopt Biome', published_at: '2026-05-04' }),
    m({ source_group: 'g2', item_key: 'k2', title: 'Biome vs ESLint in practice', published_at: '2026-05-05' }),
    m({ source_group: 'g3', item_key: 'k3', title: 'Migrating a monorepo to Biome', published_at: '2026-05-11' }),
  ];

  it('promotes a tool that clears every gate to a Signal', () => {
    const [entry] = aggregate(signalMentions, { stackNames: stack, asOf: '2026-12-31' });
    expect(entry).toMatchObject({
      tool_key: 'biome',
      distinct_source_groups: 3,
      distinct_weeks: 2,
      distinct_stories: 3,
      related_to_stack: ['eslint', 'prettier'],
      is_signal: true,
    });
  });

  it('counts independence by publisher group, not feed id (same-group double-feed = one source)', () => {
    const sameGroup = signalMentions.map((x) => ({ ...x, source_group: 'github-trending' }));
    const [entry] = aggregate(sameGroup, { stackNames: stack, asOf: '2026-12-31' });
    expect(entry?.distinct_source_groups).toBe(1);
    expect(entry?.is_signal).toBe(false); // <3 groups
  });

  it('keeps an unrelated tool out of Signals even when sources/weeks clear', () => {
    const unrelated = signalMentions.map((x) => ({ ...x, tool_key: 'some-tool', display_name: 'SomeTool' }));
    const [entry] = aggregate(unrelated, { stackNames: stack, asOf: '2026-12-31' });
    expect(entry?.distinct_source_groups).toBe(3);
    expect(entry?.related_to_stack).toEqual([]);
    expect(entry?.is_signal).toBe(false); // no stack relation → Emerging
  });

  it('holds a single release echoed by several outlets out of Signals (spike guard)', () => {
    const spike: TrendMention[] = [
      m({ source_group: 'g1', item_key: 'k1', title: 'Biome 2.0.0 released', published_at: '2026-05-04' }),
      m({ source_group: 'g2', item_key: 'k2', title: 'Announcing Biome 2.0.0', published_at: '2026-05-05' }),
      m({ source_group: 'g3', item_key: 'k3', title: 'Biome 2.0.0 is here', published_at: '2026-05-11' }),
    ];
    const [entry] = aggregate(spike, { stackNames: stack, asOf: '2026-12-31' });
    expect(entry?.distinct_source_groups).toBe(3); // clears counts...
    expect(entry?.is_signal).toBe(false); // ...but all one release cluster
  });

  it('uses observed_at for week math when published_at is missing', () => {
    const noDate = signalMentions.map((x) => ({ ...x, published_at: null, observed_at: '2026-05-04' }));
    const [entry] = aggregate(noDate, { stackNames: stack, asOf: '2026-12-31' });
    expect(entry?.distinct_weeks).toBe(1); // all fall back to the same observed week
    expect(entry?.first_seen).toBe('2026-05-04');
  });

  it('excludes mentions dated after asOf (reproducible scheduled runs)', () => {
    // Two of the three stories are in the future relative to asOf → tool drops below the gate.
    const entries = aggregate(signalMentions, { stackNames: stack, asOf: '2026-05-04' });
    expect(entries[0]?.distinct_stories).toBe(1);
    expect(entries[0]?.is_signal).toBe(false);
  });
});
