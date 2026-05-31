import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AiTransport, createAiClient } from '../src/ai/client.js';
import type { AnalysisInput, TokenUsage } from '../src/types/ai.js';
import { Cache } from '../src/utils/cache.js';

const input = (over: Partial<AnalysisInput> = {}): AnalysisInput => ({
  package: 'react',
  locked_version: '18.0.0',
  latest_version: '19.0.0',
  update_type: 'major',
  notes: [{ version: '19.0.0', url: 'https://gh/19', source: 'github_release', text: 'BREAKING: removed defaultProps.' }],
  profile: null,
  ...over,
});

const usage: TokenUsage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const goodRaw = {
  package: 'react',
  summary: 'removes defaultProps',
  evidence: [{ version: '19.0.0', type: 'breaking', quote: 'BREAKING: removed defaultProps.', url: 'https://gh/19' }],
  extracted_signals: { security_related: false, breaking_changes: [], deprecations: [], bugfixes: [], performance_improvements: [], new_features: [] },
  mentioned_apis: [],
  evidence_quality: 'high',
  caveats: [],
};

/** Counting fake transport (offline). */
function fake(raw: unknown): { transport: AiTransport; calls: () => number } {
  let n = 0;
  return { transport: { complete: async () => ((n += 1), { raw, usage }) }, calls: () => n };
}

function tmpCache(): Cache {
  return new Cache(join(mkdtempSync(join(tmpdir(), 'sr-ai-')), 'cache'));
}

describe('createAiClient', () => {
  it('calls the transport on a miss, validates, caches, reports usage', async () => {
    const { transport, calls } = fake(goodRaw);
    const r = await createAiClient({ transport, cache: tmpCache() }).analyze(input());
    expect(r.cached).toBe(false);
    expect(r.usage).toEqual(usage);
    expect(r.evidence.evidence_quality).toBe('high');
    expect(calls()).toBe(1);
  });

  it('serves a 2nd identical request from cache with zero API calls', async () => {
    const { transport, calls } = fake(goodRaw);
    const cache = tmpCache();
    const c = createAiClient({ transport, cache });
    await c.analyze(input());
    const r2 = await c.analyze(input());
    expect(r2.cached).toBe(true);
    expect(r2.usage).toBeNull();
    expect(calls()).toBe(1);
  });

  it('refresh re-analyzes (bypasses cache reads)', async () => {
    const { transport, calls } = fake(goodRaw);
    const cache = tmpCache();
    await createAiClient({ transport, cache }).analyze(input());
    await createAiClient({ transport, cache, refresh: true }).analyze(input());
    expect(calls()).toBe(2);
  });

  it('dry-run surfaces the prompt without calling the transport or writing cache', async () => {
    const { transport, calls } = fake(goodRaw);
    const cache = tmpCache();
    const prompts: string[] = [];
    const r = await createAiClient({ transport, cache, dryRun: true, onDryRun: (_i, p) => prompts.push(p.user) }).analyze(input());
    expect(calls()).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(r.evidence.evidence_quality).toBe('unavailable');
    // nothing was cached: a real client now misses and calls
    await createAiClient({ transport, cache }).analyze(input());
    expect(calls()).toBe(1);
  });

  it('degrades to provider-unavailable on a transport error, and does not cache it', async () => {
    let n = 0;
    const transport: AiTransport = { complete: async () => ((n += 1), Promise.reject(new Error('boom'))) };
    const cache = tmpCache();
    const c = createAiClient({ transport, cache });
    const r = await c.analyze(input());
    expect(r.evidence.evidence_quality).toBe('unavailable');
    expect(r.evidence.summary).toMatch(/provider unavailable/i);
    await c.analyze(input()); // failures aren't cached → calls again
    expect(n).toBe(2);
  });

  it('skips the API entirely when there are no notes to ground evidence in', async () => {
    const { transport, calls } = fake(goodRaw);
    const r = await createAiClient({ transport, cache: tmpCache() }).analyze(input({ notes: [] }));
    expect(calls()).toBe(0);
    expect(r.evidence.evidence_quality).toBe('unavailable');
    expect(r.evidence.summary).toMatch(/no changelog text/i);
  });

  it('keys the cache on the changelog text (different text → new call)', async () => {
    const { transport, calls } = fake(goodRaw);
    const cache = tmpCache();
    const c = createAiClient({ transport, cache });
    await c.analyze(input());
    await c.analyze(input({ notes: [{ version: '19.0.0', url: 'https://gh/19', source: 'github_release', text: 'different body' }] }));
    expect(calls()).toBe(2);
  });
});
