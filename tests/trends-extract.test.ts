import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildExtractionPrompt, createTrendExtractor, validateExtraction } from '../src/trends/extract.js';
import type { LlmPrompt, LlmTransport } from '../src/ai/transport.js';
import type { FeedItem } from '../src/types/trend.js';
import { Cache } from '../src/utils/cache.js';

function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    source_id: 'jsw',
    source_group: 'cooperpress',
    source_name: 'JavaScript Weekly',
    item_key: 'https://example.com/1',
    link: 'https://example.com/1',
    title: 'Biome 2 lands',
    summary: 'Biome now formats and lints; many teams are migrating off ESLint and Prettier.',
    published_at: '2026-05-01',
    ...over,
  };
}

const usage = { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fakeTransport(raw: unknown): { transport: LlmTransport; calls: () => number } {
  let n = 0;
  return {
    transport: {
      complete: async () => {
        n += 1;
        return { raw, usage };
      },
    },
    calls: () => n,
  };
}

describe('validateExtraction (quote grounding)', () => {
  const text = `${item().title}\n${item().summary}`;
  it('keeps tools whose quote is an exact substring and drops invented ones', () => {
    const tools = validateExtraction(
      {
        tools: [
          { display_name: 'Biome', canonical_hint: '@biomejs/biome', evidence_quote: 'Biome now formats and lints' },
          { display_name: 'ESLint', canonical_hint: 'eslint', evidence_quote: 'migrating off ESLint and Prettier' },
          { display_name: 'Webpack', canonical_hint: 'webpack', evidence_quote: 'Webpack is also great' }, // not in text → dropped
          { display_name: '', canonical_hint: '', evidence_quote: 'Biome now formats and lints' }, // empty name → dropped
        ],
      },
      text,
    );
    expect(tools.map((t) => t.display_name)).toEqual(['Biome', 'ESLint']);
    expect(tools[0]?.canonical_hint).toBe('@biomejs/biome');
  });

  it('treats an empty canonical_hint as absent and de-dups by display name', () => {
    const tools = validateExtraction(
      {
        tools: [
          { display_name: 'Biome', canonical_hint: '', evidence_quote: 'Biome now formats and lints' },
          { display_name: 'biome', canonical_hint: '', evidence_quote: 'Biome now formats and lints' }, // dup
        ],
      },
      text,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]?.canonical_hint).toBeUndefined();
  });

  it('returns [] for malformed model output', () => {
    expect(validateExtraction(null, text)).toEqual([]);
    expect(validateExtraction({ tools: 'nope' }, text)).toEqual([]);
  });
});

describe('createTrendExtractor', () => {
  const goodRaw = { tools: [{ display_name: 'Biome', canonical_hint: '@biomejs/biome', evidence_quote: 'Biome now formats and lints' }] };

  it('extracts validated tools and records usage; second call hits the cache', async () => {
    const cache = new Cache(mkdtempSync(join(tmpdir(), 'sr-tx-')));
    const { transport, calls } = fakeTransport(goodRaw);
    const ex = createTrendExtractor({ transport, cache });

    const first = await ex.extract(item());
    expect(first.tools.map((t) => t.display_name)).toEqual(['Biome']);
    expect(first.usage).toEqual(usage);
    expect(first.cached).toBe(false);
    expect(first.status).toBe('ok');

    const second = await ex.extract(item());
    expect(second.cached).toBe(true);
    expect(second.usage).toBeNull();
    expect(second.status).toBe('cached');
    expect(calls()).toBe(1); // served from cache, no second API call
  });

  it('refresh bypasses the cache', async () => {
    const cache = new Cache(mkdtempSync(join(tmpdir(), 'sr-tx-')));
    const { transport, calls } = fakeTransport(goodRaw);
    await createTrendExtractor({ transport, cache }).extract(item());
    await createTrendExtractor({ transport, cache, refresh: true }).extract(item());
    expect(calls()).toBe(2);
  });

  it('dry-run prints the prompt, makes no call, and returns no tools', async () => {
    const seen: { item: FeedItem; prompt: LlmPrompt }[] = [];
    const { transport, calls } = fakeTransport(goodRaw);
    const ex = createTrendExtractor({ transport, dryRun: true, onDryRun: (it, prompt) => seen.push({ item: it, prompt }) });
    const res = await ex.extract(item());
    expect(res.tools).toEqual([]);
    expect(calls()).toBe(0);
    expect(seen[0]?.prompt.user).toContain('Biome 2 lands');
  });

  it('degrades a provider error to no tools without throwing', async () => {
    const transport: LlmTransport = { complete: async () => Promise.reject(new Error('boom')) };
    const res = await createTrendExtractor({ transport }).extract(item());
    expect(res.tools).toEqual([]);
    expect(res.usage).toBeNull();
    expect(res.status).toBe('error'); // distinguishable from a clean "no tools found"
  });

  it('the prompt + validation text contain only the public title and summary', () => {
    const { prompt, text } = buildExtractionPrompt(item());
    expect(text).toBe('Biome 2 lands\nBiome now formats and lints; many teams are migrating off ESLint and Prettier.');
    expect(prompt.user).toContain('Biome 2 lands');
  });
});
