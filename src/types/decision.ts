/**
 * Types for `.stack-radar/decisions.json` — the feedback loop (PLAN.md §11, M7).
 * An engineer records a judgement on a package update; `recommend` reads these
 * back so it stops re-pushing things already decided. Deterministic, no AI.
 *
 * The action list is the single source of truth: the string-literal type is
 * derived from it so validation (decisions/store.ts) and the type never drift.
 */

import type { Recommendation } from './score.js';

export const DECISION_ACTIONS = ['snooze', 'decline', 'accept'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** One recorded judgement. Keyed (for upsert/match) by (package, version_range). */
export interface Decision {
  /** Package name as the engineer typed it; matched against name AND resolved_name. */
  package: string;
  action: DecisionAction;
  /** Optional semver range scoping the decision (e.g. "19.x"); absent = any version. */
  version_range?: string;
  /** Free-text rationale, surfaced in the report. */
  reason?: string;
  /** Snooze end date (YYYY-MM-DD). Required for snooze, absent otherwise. */
  until?: string;
  /** ISO timestamp; drives newest-wins precedence. Never printed in the report. */
  created_at: string;
}

export interface DecisionsFile {
  version: 1;
  decisions: Decision[];
}

/**
 * The effect a matched decision has on one scored record, computed at report
 * time (decisions/apply.ts). Lives on the report-facing ScoredRecord, never on
 * ScoreResult — a user judgement is not scoring.
 */
export interface DecisionEffect {
  action: DecisionAction;
  /** Effective recommendation after the decision (equals the input when unchanged). */
  recommendation: Recommendation;
  /** True only for an active snooze: excluded from sections + stdout buckets. */
  hidden: boolean;
  /** One-line marker rendered under the item / in the appendix. */
  marker: string;
  /** Optional rationale carried from the decision. */
  note?: string;
  /** True when a decline was bypassed because the version carries a security advisory. */
  securityOverride: boolean;
}

export function emptyDecisionsFile(): DecisionsFile {
  return { version: 1, decisions: [] };
}
