/**
 * Types for the AI Evidence Layer (M5, PLAN §6). The AI extracts structured
 * evidence from changelog text to enrich the report and inform Confidence — it
 * never decides the Recommendation (the rule engine owns that).
 */

import type { UpdateType } from './update.js';

/** Which AI backend served a run: the Anthropic API, or a local CLI (claude/codex). */
export type AiBackend = 'api' | 'claude-cli' | 'codex-cli';

export const AI_BACKENDS: readonly AiBackend[] = ['api', 'claude-cli', 'codex-cli'];

/** Classification of a single evidence item (what kind of change a quote shows). */
export type EvidenceType = 'security' | 'breaking' | 'deprecation' | 'bugfix' | 'performance' | 'feature' | 'other';

/**
 * Reliability of the extracted evidence. The model returns one of high/medium/low;
 * `unavailable` is set by our code when the AI could not run (provider error) or
 * there was no changelog text to analyze — kept distinct so the report can say
 * "AI provider unavailable" rather than implying the changelog was empty.
 */
export type EvidenceQuality = 'high' | 'medium' | 'low' | 'unavailable';

/** Quality values the MODEL is allowed to return (the JSON-schema enum). */
export const MODEL_EVIDENCE_QUALITIES = ['high', 'medium', 'low'] as const;
export const EVIDENCE_TYPES: readonly EvidenceType[] = ['security', 'breaking', 'deprecation', 'bugfix', 'performance', 'feature', 'other'];

export interface AiEvidenceItem {
  version: string;
  type: EvidenceType;
  /** Verbatim quote from the supplied changelog text (validated as a substring). */
  quote: string;
  /** Source URL — must be one of the release-note URLs we supplied. */
  url: string;
}

/** Structured signals the rule engine may consume (value hooks land in M6). */
export interface ExtractedSignals {
  security_related: boolean;
  breaking_changes: string[];
  deprecations: string[];
  bugfixes: string[];
  performance_improvements: string[];
  new_features: string[];
}

/** The AI's structured output for one package (PLAN §6 schema). */
export interface AiEvidence {
  package: string;
  summary: string;
  evidence: AiEvidenceItem[];
  extracted_signals: ExtractedSignals;
  mentioned_apis: string[];
  evidence_quality: EvidenceQuality;
  caveats: string[];
}

export function emptyExtractedSignals(): ExtractedSignals {
  return {
    security_related: false,
    breaking_changes: [],
    deprecations: [],
    bugfixes: [],
    performance_improvements: [],
    new_features: [],
  };
}

/**
 * Evidence placeholder used when the AI did not produce usable output.
 * `summary` explains why so the report can surface it honestly.
 */
export function emptyAiEvidence(pkg: string, quality: EvidenceQuality, summary: string): AiEvidence {
  return {
    package: pkg,
    summary,
    evidence: [],
    extracted_signals: emptyExtractedSignals(),
    mentioned_apis: [],
    evidence_quality: quality,
    caveats: [],
  };
}

/** Token usage for one real API call (zeros on cache hit / dry-run). */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

/** Run-level AI summary for the report appendix. */
export interface AiRunSummary {
  model: string;
  /** Which backend served this run (api | claude-cli | codex-cli). */
  backend: AiBackend;
  /** Records sent through analyze() (incl. cached / skipped / unavailable). */
  analyzed: number;
  /** Real API calls made (excludes cache hits, dry-run, and no-note skips). */
  calls: number;
  /** Served from the on-disk cache. */
  cached: number;
  input_tokens: number;
  output_tokens: number;
  /** Anthropic prompt-cache reads/writes (the system+schema prefix across calls). */
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  dry_run: boolean;
}

/** Outcome of analyzing one package. */
export interface AiResult {
  evidence: AiEvidence;
  /** Usage for a real call; null when served from the disk cache or in dry-run. */
  usage: TokenUsage | null;
  /** True when served from our on-disk cache (no API call). */
  cached: boolean;
}

/** Outcome of a single package's AI analysis, surfaced to the progress reporter. */
export type AiProgressStatus = 'cached' | 'fresh' | 'dry-run' | 'unavailable';

/** Emitted once before the AI fan-out begins, so the UI can print a header. */
export interface AiStartInfo {
  total: number;
  model: string;
  dry_run: boolean;
}

/** Emitted once per record as AI analysis completes. `completed_count` is the
 * running count in completion order (1-based), not the input position. */
export interface AiProgressEvent {
  completed_count: number;
  total: number;
  package: string;
  status: AiProgressStatus;
  usage: TokenUsage | null;
}

/** One supplied release note (only those WITH text reach the AI). */
export interface AnalysisNote {
  version: string;
  url: string;
  source: string;
  text: string;
  /** True when `text` was truncated, so a complete and a cut 4000-char note aren't collapsed. */
  truncated?: boolean;
}

/**
 * Everything the AI is given for one package. Deliberately has NO field that can
 * carry source code — only public package metadata, changelog text, and the
 * project's coarse profile. This is the privacy boundary (PLAN §14).
 */
export interface AnalysisInput {
  package: string;
  locked_version: string | null;
  latest_version: string | null;
  update_type: UpdateType;
  notes: AnalysisNote[];
  profile: { product_type: string; tech_taste: string } | null;
}
