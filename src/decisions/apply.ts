import semver from 'semver';
import { finalRecommendation } from '../scoring/index.js';
import type { Decision, DecisionEffect, DecisionsFile } from '../types/decision.js';
import type { Recommendation, ScoreResult } from '../types/score.js';
import type { UpdateRecord } from '../types/update.js';

/**
 * The feedback layer (M7, PLAN §11). PURE: turns a recorded decision into its
 * effect on one already-scored record. Decisions are USER STATE, never scoring —
 * they live on the report-facing record, not on ScoreResult, and never touch
 * `finalRecommendation`. Matching is date-independent; only snooze expiry uses
 * the as-of date (the report date), keeping everything deterministic.
 */

/** True if a decision governs this record: package matches (incl. alias), range satisfies latest. */
function matchesRecord(decision: Decision, record: UpdateRecord): boolean {
  const pkgMatch =
    decision.package === record.name ||
    (record.resolved_name !== undefined && decision.package === record.resolved_name);
  if (!pkgMatch) return false;
  if (decision.version_range === undefined) return true; // package-wide
  if (record.latest_version === null) return false;
  return semver.satisfies(record.latest_version, decision.version_range, { includePrerelease: true });
}

/**
 * The single decision governing a record, or null. Among multiple matches the
 * newest `created_at` wins (canonical ISO sorts chronologically); ties break
 * range-scoped before package-wide, then lexically — fully deterministic.
 */
export function resolveDecision(record: UpdateRecord, file: DecisionsFile): Decision | null {
  const matches = file.decisions.filter((d) => matchesRecord(d, record));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return [...matches].sort(byPrecedence)[0] ?? null;
}

function byPrecedence(a: Decision, b: Decision): number {
  const t = b.created_at.localeCompare(a.created_at); // newest first
  if (t !== 0) return t;
  const scopedFirst = (a.version_range ? 0 : 1) - (b.version_range ? 0 : 1); // range before package-wide
  if (scopedFirst !== 0) return scopedFirst;
  return (
    (a.version_range ?? '').localeCompare(b.version_range ?? '') ||
    a.package.localeCompare(b.package) ||
    a.action.localeCompare(b.action)
  );
}

/** A snooze still in effect as of `asOfDate` (YYYY-MM-DD): hidden until the date, resurfaces ON it. */
export function isActiveSnooze(decision: Decision, asOfDate: string): boolean {
  return decision.action === 'snooze' && decision.until !== undefined && asOfDate < decision.until;
}

/**
 * A non-security decline de-emphasizes to Watch. Blocked/Defer are already at or
 * above Watch's caution and stay put; everything else (incl. a non-security
 * Upgrade Now from the R5 perf-pain rule) drops to Watch.
 */
function declineToWatch(rec: Recommendation): Recommendation {
  return rec === 'Blocked' || rec === 'Defer' ? rec : 'Watch';
}

/**
 * The effect of the governing decision on this record, or undefined for none /
 * an expired snooze (→ resurfaces normally). `baseFinal` is the profile-adjusted
 * recommendation (`finalRecommendation(score)`).
 *
 * - accept  → marker only; recommendation unchanged.
 * - snooze  → hidden (excluded from sections + stdout buckets) while active.
 * - decline → de-emphasize to Watch, UNLESS the version carries a security
 *   advisory (signal or advisory entry), in which case the rec is preserved and
 *   only marked. (We can't know if the advisory is *new* since the decline —
 *   detecting that needs stored advisory IDs, out of M7 scope.)
 */
export function applyDecision(
  baseFinal: Recommendation,
  record: UpdateRecord,
  decision: Decision | null,
  asOfDate: string,
): DecisionEffect | undefined {
  if (!decision) return undefined;

  switch (decision.action) {
    case 'accept':
      return { action: 'accept', recommendation: baseFinal, hidden: false, marker: 'previously accepted', note: decision.reason, securityOverride: false };

    case 'snooze':
      if (!isActiveSnooze(decision, asOfDate)) return undefined; // expired → resurfaces
      return { action: 'snooze', recommendation: baseFinal, hidden: true, marker: `snoozed until ${decision.until}`, note: decision.reason, securityOverride: false };

    case 'decline': {
      const hasSecurity = record.signals.security || record.advisories.length > 0;
      if (hasSecurity) {
        return {
          action: 'decline',
          recommendation: baseFinal,
          hidden: false,
          marker: 'previously declined — shown anyway: this version carries a security advisory',
          note: decision.reason,
          securityOverride: true,
        };
      }
      return { action: 'decline', recommendation: declineToWatch(baseFinal), hidden: false, marker: 'previously declined', note: decision.reason, securityOverride: false };
    }
  }
}

/**
 * The recommendation to act on AFTER the feedback layer: the decision's effective
 * recommendation when one applies, else the (profile-adjusted) score's. Shared by
 * the renderer's bucketing and the `recommend` stdout summary so no surface
 * diverges — the M7 analogue of `finalRecommendation`. Hidden snoozes must be
 * filtered separately (their recommendation is meaningless once hidden).
 */
export function effectiveRecommendation(score: ScoreResult, decision?: DecisionEffect): Recommendation {
  return decision?.recommendation ?? finalRecommendation(score);
}
