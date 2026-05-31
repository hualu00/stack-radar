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

  const signals: ExtractedSignals = isObject(raw.extracted_signals)
    ? {
        security_related: raw.extracted_signals.security_related === true,
        breaking_changes: asStringArray(raw.extracted_signals.breaking_changes),
        deprecations: asStringArray(raw.extracted_signals.deprecations),
        bugfixes: asStringArray(raw.extracted_signals.bugfixes),
        performance_improvements: asStringArray(raw.extracted_signals.performance_improvements),
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

  return {
    evidence: {
      package: input.package, // never trust the model's echo of the name
      summary: asString(raw.summary),
      evidence,
      extracted_signals: signals,
      mentioned_apis: asStringArray(raw.mentioned_apis),
      evidence_quality: quality,
      caveats,
    },
    scrubbed,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
