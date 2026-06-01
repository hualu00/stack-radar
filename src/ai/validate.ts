import {
  type AiEvidence,
  type AiEvidenceItem,
  type AnalysisInput,
  EVIDENCE_TYPES,
  type EvidenceType,
  type ExtractedSignals,
  emptyAiEvidence,
  emptyExtractedSignals,
} from '../types/ai.js';

export interface ValidationResult {
  evidence: AiEvidence;
  /** True if any model-provided evidence item was rejected (likely fabrication). */
  scrubbed: boolean;
}

/**
 * Defensively coerce + validate the model's raw JSON into AiEvidence (M5).
 * Anti-fabrication is the point: every kept evidence item must cite a URL we
 * supplied AND quote an exact substring of THAT SAME note's text. Items that
 * fail are dropped, and any drop forces evidence_quality to `low` with a caveat,
 * so the rule engine never consumes invented evidence. Pure + deterministic.
 */
export function validateEvidence(raw: unknown, input: AnalysisInput): ValidationResult {
  if (!isObject(raw)) {
    return { evidence: emptyAiEvidence(input.package, 'low', 'AI returned malformed output'), scrubbed: true };
  }

  const noteByUrl = new Map(input.notes.map((n) => [n.url, n]));
  // The full supplied changelog text — the substring oracle for grounding the model's
  // mentioned_apis (a hallucinated API name that's nowhere in the notes is dropped before
  // it can drive the code-relevance scan).
  const notesText = input.notes.map((n) => n.text).join('\n');

  const evidence: AiEvidenceItem[] = [];
  let scrubbed = false;
  for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (!isObject(item)) {
      scrubbed = true;
      continue;
    }
    const url = asString(item.url);
    const quote = asString(item.quote);
    const note = noteByUrl.get(url);
    if (note === undefined || quote.trim() === '' || !note.text.includes(quote)) {
      scrubbed = true; // fabricated quote, wrong/unknown url, or quote not from that note
      continue;
    }
    // Ground version on the matched note rather than trusting the model's echo.
    evidence.push({ version: note.version, type: asEvidenceType(item.type), quote, url });
  }

  // `performance_improvements` is the only extracted signal the rule engine acts on (R5 → Upgrade Now),
  // so it must be grounded: trust it only when a grounded performance EVIDENCE item survived quote
  // validation. Otherwise an ungrounded perf claim (easy with a prompt-only CLI schema) is dropped so
  // it can't elevate the recommendation.
  const claimedPerf = isObject(raw.extracted_signals) ? asStringArray(raw.extracted_signals.performance_improvements) : [];
  const hasGroundedPerf = evidence.some((e) => e.type === 'performance');
  const signals: ExtractedSignals = isObject(raw.extracted_signals)
    ? {
        security_related: raw.extracted_signals.security_related === true,
        breaking_changes: asStringArray(raw.extracted_signals.breaking_changes),
        deprecations: asStringArray(raw.extracted_signals.deprecations),
        bugfixes: asStringArray(raw.extracted_signals.bugfixes),
        performance_improvements: hasGroundedPerf ? claimedPerf : [],
        new_features: asStringArray(raw.extracted_signals.new_features),
      }
    : emptyExtractedSignals();

  // Any scrubbing means the model produced unsupported claims → don't trust its quality.
  let quality = asQuality(raw.evidence_quality);
  const caveats = asStringArray(raw.caveats);
  if (scrubbed) {
    quality = 'low';
    caveats.push('Some AI-provided evidence did not match the supplied changelog and was dropped.');
  }
  if (claimedPerf.length > 0 && !hasGroundedPerf) {
    caveats.push('AI-reported performance improvements lacked a grounded changelog quote and were not used for scoring.');
  }

  return {
    evidence: {
      package: input.package, // never trust the model's echo of the name
      summary: asString(raw.summary),
      evidence,
      extracted_signals: signals,
      // Ground mentioned_apis to names that occur as a WHOLE identifier in the supplied changelog
      // text (not a mere substring) — else a hallucinated 'use' would be "grounded" by 'users', and
      // its zero-match relevance scan could wrongly downgrade a breaking major to Watch.
      mentioned_apis: asStringArray(raw.mentioned_apis).filter((a) => isIdentifierInText(a, notesText)),
      evidence_quality: quality,
      caveats,
    },
    scrubbed,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** Whole-identifier match (mirrors the relevance searcher's word-boundary rule) so a name is
 * grounded only if it appears as a standalone token, not as a substring of a larger word. */
function isIdentifierInText(api: string, text: string): boolean {
  const a = api.trim();
  if (a === '') return false;
  return new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
}
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function asEvidenceType(v: unknown): EvidenceType {
  return typeof v === 'string' && (EVIDENCE_TYPES as readonly string[]).includes(v) ? (v as EvidenceType) : 'other';
}
function asQuality(v: unknown): 'high' | 'medium' | 'low' {
  return v === 'high' || v === 'medium' ? v : 'low';
}
