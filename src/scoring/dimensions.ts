import type { AiEvidence } from '../types/ai.js';
import type { Relevance } from '../types/relevance.js';
import type { Dimension } from '../types/score.js';
import type { Confidence, UpdateRecord } from '../types/update.js';
import type { BlockedResult } from './blocked.js';

/** urgency: how soon this needs handling (security > deprecation > baseline). */
export function scoreUrgency(record: UpdateRecord): Dimension {
  if (record.signals.security) return 'high';
  if (record.signals.deprecation) return 'medium';
  return 'low';
}

/** risk: how breaking the upgrade is. */
export function scoreRisk(record: UpdateRecord, blocked: BlockedResult): Dimension {
  if (
    blocked.blocked ||
    record.signals.breaking ||
    record.update_type === 'major' ||
    record.update_type === 'prerelease'
  ) {
    return 'high';
  }
  if (
    blocked.missingPeers.length > 0 ||
    record.signals.peer_dependency_changed ||
    record.signals.node_requirement_changed
  ) {
    return 'medium';
  }
  return 'low'; // minor / patch
}

/**
 * value: visible benefit to THIS project. When a code-relevance scan ran (M6),
 * value reflects whether the changed APIs are actually used: any usage → medium,
 * zero usage → none (irrelevant to you). Without a scan it falls back to the M3
 * heuristic (has-changelog → medium, else low). Security always wins.
 */
export function scoreValue(record: UpdateRecord, relevance?: Relevance): Dimension {
  if (record.signals.security) return 'high';
  // Only a COMPLETE scan with valid searched APIs can prove (ir)relevance. A capped
  // (partial) scan is too weak to claim `none`, so fall back to the heuristic.
  if (relevance?.scanned && relevance.mentioned > 0 && !relevance.capped) {
    return relevance.total_matches > 0 ? 'medium' : 'none';
  }
  return record.release_notes.length > 0 ? 'medium' : 'low';
}

/**
 * confidence: reliability of the evidence (PLAN §8 "any factor low -> overall low").
 * When AI evidence is supplied (M5), it can only LOWER confidence: low/unavailable
 * evidence floors the result to low. AI never raises confidence — that stays driven
 * by the structured data (release-note source, advisories).
 */
export function scoreConfidence(record: UpdateRecord, evidence?: AiEvidence): Confidence {
  if (record.status === 'error' || record.status === 'partial' || record.status === 'not_found') return 'low';
  const hasGithub = record.release_notes.some((n) => n.source === 'github_release');
  const hasChangelog = record.release_notes.some((n) => n.source === 'changelog_md');
  let base: Confidence = hasGithub ? 'high' : hasChangelog ? 'medium' : 'low';
  if (record.advisories.length > 0 && base === 'low') base = 'medium'; // concrete advisory data
  if (evidence && (evidence.evidence_quality === 'low' || evidence.evidence_quality === 'unavailable')) return 'low';
  return base;
}

/**
 * Plain-language explanation of why `scoreConfidence` did not reach `high`. Branch
 * order tracks `scoreConfidence` (status floor first, then AI floor, then source
 * ladder) so the surfaced reason matches whichever rule actually pinned the score.
 * Returns null when confidence already is high (no caveat to show).
 */
export function confidenceReason(record: UpdateRecord, evidence?: AiEvidence): string | null {
  if (record.status === 'error') return 'data fetch error';
  if (record.status === 'partial') return 'incomplete data fetch';
  if (record.status === 'not_found') return 'package not found in registry';
  const hasGithub = record.release_notes.some((n) => n.source === 'github_release');
  const hasChangelog = record.release_notes.some((n) => n.source === 'changelog_md');
  if (evidence?.evidence_quality === 'unavailable') return 'AI evidence unavailable';
  if (evidence?.evidence_quality === 'low') return 'AI evidence quality is low';
  if (hasGithub) return null;
  if (hasChangelog) return 'CHANGELOG.md only, no GitHub Release';
  if (record.advisories.length > 0) return 'advisory only, no release notes';
  return 'no release notes available';
}
