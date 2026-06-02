import type { AiEvidence } from '../types/ai.js';
import type { ProjectProfile } from '../types/profile.js';
import type { Relevance } from '../types/relevance.js';
import type { ProjectContext, Recommendation, ScoreResult } from '../types/score.js';
import type { StackJson } from '../types/stack.js';
import { type Confidence, type UpdateRecord, emptyRequirements } from '../types/update.js';
import { type BlockedResult, evaluateBlocked, resolveProjectNode } from './blocked.js';
import { scoreConfidence, scoreRisk, scoreUrgency, scoreValue } from './dimensions.js';
import { applyProfile } from './profile-adjust.js';
import { decideRecommendation } from './recommend.js';

/** Build per-workspace locked-version maps from stack.json (for peer checks). */
export function buildProjectContext(
  stack: StackJson,
  opts?: { profileNode?: string | null; reviewed?: boolean },
): ProjectContext {
  const lockedByWorkspace = new Map<string, Map<string, string>>();
  for (const item of stack.items) {
    if (!item.locked_version) continue;
    let byName = lockedByWorkspace.get(item.workspace);
    if (!byName) {
      byName = new Map();
      lockedByWorkspace.set(item.workspace, byName);
    }
    byName.set(item.name, item.locked_version);
  }
  const nodeEngine = resolveProjectNode({
    profileNode: opts?.profileNode ?? null,
    reviewed: opts?.reviewed ?? false,
    nvmrc: stack.runtime.nvmrc ?? null,
    enginesNode: stack.runtime.node_engine,
  });
  return { nodeEngine, lockedByWorkspace };
}

/**
 * Score one update record against the project context. Pure + deterministic.
 * When `profile` is given, the M4 adjustment layer is attached as `.adjustment`
 * (the base `recommendation` stays the base — the report shows both layers).
 */
export function scoreRecord(
  record: UpdateRecord,
  ctx: ProjectContext,
  profile?: ProjectProfile,
  evidence?: AiEvidence,
  relevance?: Relevance,
): ScoreResult {
  const workspaces = record.instances.map((i) => i.workspace);
  const blocked = evaluateBlocked(record.requirements ?? emptyRequirements(), workspaces, ctx);

  const urgency = scoreUrgency(record);
  const risk = scoreRisk(record, blocked);
  // Code relevance (M6) feeds value; AI evidence (M5) only informs confidence.
  const value = scoreValue(record, relevance);
  const confidence = scoreConfidence(record, evidence);
  const recommendation = decideRecommendation({ record, blocked, risk, value, relevance });

  const result: ScoreResult = {
    recommendation,
    confidence,
    urgency,
    risk,
    value,
    reasons: buildReasons(record, blocked),
    caveats: buildCaveats(record, blocked, confidence, relevance),
  };
  // R5 needs AI evidence (performance_improvements); profile drives the adjustment.
  if (profile) result.adjustment = applyProfile(result, profile, record, evidence);
  return result;
}

function buildReasons(record: UpdateRecord, blocked: BlockedResult): string[] {
  const reasons: string[] = [];
  reasons.push(...blocked.reasons);

  if (record.signals.security) {
    const ids = record.advisories.map((a) => a.id).join(', ');
    reasons.push(`Security advisory affects the locked version${ids ? ` (${ids})` : ''}`);
  }
  if (record.signals.breaking) reasons.push('Release notes mention breaking changes');
  if (record.signals.deprecation) reasons.push('Package/version is deprecated');
  if (record.signals.peer_dependency_changed) reasons.push('peerDependencies changed between locked and latest');
  if (record.signals.node_requirement_changed) reasons.push('Node engine requirement changed');
  for (const name of blocked.missingPeers) {
    reasons.push(`Latest requires peer \`${name}\`, which is not installed in the project`);
  }
  if (
    !record.signals.breaking &&
    !record.signals.security &&
    (record.update_type === 'patch' || record.update_type === 'minor')
  ) {
    reasons.push('No breaking changes detected in the update range');
  }
  reasons.push(`${capitalize(record.update_type)} update: ${record.locked_version ?? '?'} → ${record.latest_version ?? '?'}`);
  return reasons;
}

function buildCaveats(
  record: UpdateRecord,
  blocked: BlockedResult,
  confidence: Confidence,
  relevance?: Relevance,
): string[] {
  const caveats: string[] = [];
  caveats.push(...blocked.caveats);

  if (record.status === 'partial') {
    caveats.push('Advisory data was unavailable this run; the security signal may be incomplete');
  }
  if (record.signals.security && record.release_notes.length === 0) {
    // Advisory floors confidence to medium, so key off the missing changelog directly.
    caveats.push(
      'Evidence is from the advisory only; release notes are missing, so upgrade risk is not independently confirmed by a changelog',
    );
  } else if (confidence === 'low') {
    caveats.push('Limited changelog evidence (confidence: low)');
  }
  for (const name of blocked.missingPeers) {
    caveats.push(`Peer \`${name}\` is required but not installed; package managers differ on auto-install`);
  }
  if (relevance?.scanned && relevance.mentioned > 0) {
    caveats.push('Project relevance is grep-based (counts may include comments/strings); AST validation pending');
  } else {
    caveats.push('Value is a heuristic estimate; run with --use-ai to factor in code relevance');
  }
  return caveats;
}

const RECOMMENDATION_ORDER: Recommendation[] = [
  'Upgrade Now',
  'Safe to Upgrade',
  'Review First',
  'Watch',
  'Blocked',
  'Defer',
];

/** Stable section order for the report (re-exported for the renderer). */
export function recommendationOrder(): Recommendation[] {
  return [...RECOMMENDATION_ORDER];
}

/**
 * The recommendation to act on: the profile-adjusted one when a profile was
 * applied, else the base. Single source of truth for report bucketing, the top
 * line, the appendix table, and the stdout summary (so no surface diverges).
 */
export function finalRecommendation(score: ScoreResult): Recommendation {
  return score.adjustment?.recommendation ?? score.recommendation;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : `${s[0]?.toUpperCase()}${s.slice(1)}`;
}
