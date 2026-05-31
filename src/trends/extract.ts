import { createHash } from 'node:crypto';
import { DEFAULT_AI_MODEL } from '../ai/client.js';
import { type LlmPrompt, type LlmTransport, createAnthropicTransport } from '../ai/transport.js';
import type { TokenUsage } from '../types/ai.js';
import type { ExtractedTool, FeedItem } from '../types/trend.js';
import type { Cache } from '../utils/cache.js';

/** Bump when the extraction prompt/schema changes; part of the cache key. */
export const TREND_PROMPT_VERSION = 1;
const TREND_CACHE_NAMESPACE = 'trends-extractions';
/** A tool list is small; cap output tokens well below the default. */
const MAX_OUTPUT_TOKENS = 1024;

export interface TrendExtraction {
  tools: ExtractedTool[];
  /** Usage for a real call; null on cache hit / dry-run / degraded failure. */
  usage: TokenUsage | null;
  cached: boolean;
  /** Outcome, so the orchestrator can distinguish "no tools found" from a degraded call. */
  status: 'ok' | 'cached' | 'dry-run' | 'error';
}

export interface TrendExtractorOptions {
  model?: string;
  cache?: Cache;
  /** Bypass cache reads (re-extract). */
  refresh?: boolean;
  /** Print prompts without calling the API or touching the cache. */
  dryRun?: boolean;
  /** Injected in tests; defaults to the real Anthropic-backed transport. */
  transport?: LlmTransport;
  apiKey?: string;
  onDryRun?: (item: FeedItem, prompt: LlmPrompt) => void;
}

export interface TrendExtractor {
  extract(item: FeedItem): Promise<TrendExtraction>;
}

/**
 * Build a trend extractor: wraps the shared LLM transport with disk caching,
 * quote-grounded anti-fabrication validation, dry-run, and per-item graceful
 * degradation (a provider error yields no tools for that item, never aborts the
 * run). Privacy: the model only ever sees the public feed title + summary.
 */
export function createTrendExtractor(options: TrendExtractorOptions = {}): TrendExtractor {
  const model = options.model ?? DEFAULT_AI_MODEL;
  const transport = options.transport ?? createAnthropicTransport(model, options.apiKey, MAX_OUTPUT_TOKENS);
  const { cache, refresh = false, dryRun = false, onDryRun } = options;

  return {
    async extract(item: FeedItem): Promise<TrendExtraction> {
      const { prompt, text } = buildExtractionPrompt(item);

      if (dryRun) {
        onDryRun?.(item, prompt);
        return { tools: [], usage: null, cached: false, status: 'dry-run' };
      }

      const key = cacheKey(model, item);
      if (cache && !refresh) {
        const hit = cache.readJson<ExtractedTool[]>(TREND_CACHE_NAMESPACE, key);
        if (Array.isArray(hit)) return { tools: hit, usage: null, cached: true, status: 'cached' }; // ignore corrupt non-array
      }

      let raw: unknown;
      let usage: TokenUsage;
      try {
        const result = await transport.complete(prompt);
        raw = result.raw;
        usage = result.usage;
      } catch {
        return { tools: [], usage: null, cached: false, status: 'error' }; // degrade THIS item only
      }

      const tools = validateExtraction(raw, text);
      cache?.writeJson(TREND_CACHE_NAMESPACE, key, tools);
      return { tools, usage, cached: false, status: 'ok' };
    },
  };
}

/**
 * The (prompt, text) for one feed item. `text` is EXACTLY what the model is shown
 * (capped title + summary) and is the substring oracle for quote validation, so a
 * quote can never be "valid" against text the model never received.
 */
export function buildExtractionPrompt(item: FeedItem): { prompt: LlmPrompt; text: string } {
  const text = `${item.title}\n${item.summary}`;
  const user = `Title: ${item.title}\n\n${item.summary || '(no summary)'}\n\nList the developer tools/libraries/frameworks mentioned, as JSON matching the schema.`;
  return { prompt: { system: SYSTEM, user, schema: EXTRACTION_SCHEMA }, text };
}

/**
 * Keep only tools grounded in the supplied text: a non-empty display_name and an
 * evidence_quote that is an EXACT substring of `text`. Drops anything the model
 * invented from prior knowledge. Pure + deterministic.
 */
export function validateExtraction(raw: unknown, text: string): ExtractedTool[] {
  if (!isObject(raw) || !Array.isArray(raw.tools)) return [];
  const out: ExtractedTool[] = [];
  const seen = new Set<string>();
  for (const t of raw.tools) {
    if (!isObject(t)) continue;
    const display_name = typeof t.display_name === 'string' ? t.display_name.trim() : '';
    const evidence_quote = typeof t.evidence_quote === 'string' ? t.evidence_quote : '';
    if (display_name === '' || evidence_quote.trim() === '' || !text.includes(evidence_quote)) continue;
    if (seen.has(display_name.toLowerCase())) continue; // de-dup within one item
    seen.add(display_name.toLowerCase());
    const hint = typeof t.canonical_hint === 'string' && t.canonical_hint.trim() !== '' ? t.canonical_hint.trim() : undefined;
    out.push(hint ? { display_name, canonical_hint: hint, evidence_quote } : { display_name, evidence_quote });
  }
  return out;
}

function cacheKey(model: string, item: FeedItem): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: TREND_PROMPT_VERSION,
        model,
        source_id: item.source_id,
        item_key: item.item_key,
        title: item.title,
        summary: item.summary,
        published_at: item.published_at,
      }),
    )
    .digest('hex');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SYSTEM = `You identify developer tools, libraries, and frameworks MENTIONED in a short feed item (a newsletter blurb or release note) for a frontend technology radar.

Rules:
- Use ONLY the provided title and text. Do NOT use prior knowledge.
- List each distinct tool/library/framework explicitly named. For each: display_name (as written), canonical_hint (its npm package or canonical name if obvious FROM THE TEXT, else ""), and evidence_quote (a verbatim, exact substring of the provided text that names it).
- NEVER invent. If something is not actually named in the text, do not include it. If nothing qualifies, return an empty list.
- Do NOT include generic concepts ("JavaScript", "CSS", "performance", "type safety") unless they name a specific product.
- Output MUST conform exactly to the provided JSON schema.`;

const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          display_name: { type: 'string' },
          canonical_hint: { type: 'string' },
          evidence_quote: { type: 'string' },
        },
        required: ['display_name', 'canonical_hint', 'evidence_quote'],
      },
    },
  },
  required: ['tools'],
};
