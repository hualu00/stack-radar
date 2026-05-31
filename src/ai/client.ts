import { createHash } from 'node:crypto';
import { type AiEvidence, type AiResult, type AnalysisInput, emptyAiEvidence } from '../types/ai.js';
import type { Cache } from '../utils/cache.js';
import { type AnalysisPrompt, PROMPT_VERSION, buildAnalysisPrompt } from './prompts/changelog-analysis.js';
import { type LlmTransport, type TransportResult, createAnthropicTransport } from './transport.js';
import { validateEvidence } from './validate.js';

/** PLAN §15 default; a deliberate cost choice for bulk structured extraction. */
export const DEFAULT_AI_MODEL = 'claude-sonnet-4-6';
const AI_CACHE_NAMESPACE = 'ai-analyses';

/** Back-compat alias: the changelog client's transport is the shared LLM transport. */
export type AiTransport = LlmTransport;

export interface AiClient {
  analyze(input: AnalysisInput): Promise<AiResult>;
}

export interface AiClientOptions {
  model?: string;
  cache?: Cache;
  /** Bypass cache reads (re-analyze), like `check-updates --refresh`. */
  refresh?: boolean;
  /** Print prompts without calling the API or touching the cache. */
  dryRun?: boolean;
  /** Injected in tests; defaults to the real Anthropic-backed transport. */
  transport?: AiTransport;
  apiKey?: string;
  /** Called per package in dry-run with the would-be prompt. */
  onDryRun?: (input: AnalysisInput, prompt: AnalysisPrompt) => void;
}

/**
 * Build an AI client. Wraps an injectable `transport` with: disk caching
 * (identical input → identical cached output, the determinism guarantee),
 * anti-fabrication validation, dry-run, and per-package graceful degradation
 * (a provider error degrades one record, never aborts the run).
 */
export function createAiClient(options: AiClientOptions = {}): AiClient {
  const model = options.model ?? DEFAULT_AI_MODEL;
  const transport = options.transport ?? createAnthropicTransport(model, options.apiKey);
  const { cache, refresh = false, dryRun = false, onDryRun } = options;

  return {
    async analyze(input: AnalysisInput): Promise<AiResult> {
      const prompt = buildAnalysisPrompt(input);

      if (dryRun) {
        onDryRun?.(input, prompt);
        return {
          evidence: emptyAiEvidence(input.package, 'unavailable', 'dry-run: prompt not sent to the model'),
          usage: null,
          cached: false,
        };
      }

      // No changelog text → nothing to ground evidence in. Skip the call entirely
      // (cost + don't let the model fabricate against an empty prompt).
      if (input.notes.length === 0) {
        return {
          evidence: emptyAiEvidence(input.package, 'unavailable', 'no changelog text available to analyze'),
          usage: null,
          cached: false,
        };
      }

      const key = cacheKey(model, input);
      if (cache && !refresh) {
        const hit = cache.readJson<AiEvidence>(AI_CACHE_NAMESPACE, key);
        if (hit) return { evidence: hit, usage: null, cached: true };
      }

      let result: TransportResult;
      try {
        result = await transport.complete(prompt);
      } catch (err) {
        // Degrade THIS package only; never abort the run. "unavailable" is kept
        // distinct from "no changelog" so the report doesn't imply emptiness.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          evidence: emptyAiEvidence(input.package, 'unavailable', `AI provider unavailable: ${msg}`),
          usage: null,
          cached: false,
        };
      }

      const { evidence } = validateEvidence(result.raw, input);
      cache?.writeJson(AI_CACHE_NAMESPACE, key, evidence);
      return { evidence, usage: result.usage, cached: false };
    },
  };
}

/** Cache key covers everything that changes the output (codex). */
function cacheKey(model: string, input: AnalysisInput): string {
  const payload = {
    v: PROMPT_VERSION,
    model,
    pkg: input.package,
    locked: input.locked_version,
    latest: input.latest_version,
    update_type: input.update_type,
    profile: input.profile,
    notes: input.notes.map((n) => ({
      version: n.version,
      url: n.url,
      source: n.source,
      truncated: n.truncated === true,
      text_sha: sha256(n.text),
    })),
  };
  return sha256(JSON.stringify(payload));
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
