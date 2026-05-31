import type { AiEvidence } from '../types/ai.js';
import type { ProjectProfile } from '../types/profile.js';
import type { ProfileAdjustment, Recommendation, ScoreResult } from '../types/score.js';
import type { UpdateRecord } from '../types/update.js';
import { projectNodeAccepted } from './blocked.js';

/** Pain-point phrases that signal the project cares about performance. */
const PERF_PAIN = /\b(perf|performance|slow|speed|fast|latency|bundle|build[\s-]?time|memory|jank|render)\b/i;

/**
 * Caution rank within the "normal upgrade" band, used only to implement
 * floor-at-X (raise caution, never lower it). `Upgrade Now` (security) and
 * `Blocked` are fixed endpoints handled separately, never floored.
 */
const CAUTION: Record<Recommendation, number> = {
  'Safe to Upgrade': 0,
  'Review First': 1,
  Watch: 2,
  Defer: 3,
  'Upgrade Now': -1,
  Blocked: 99,
};

/**
 * Apply the project-profile adjustment layer to a BASE score (PLAN §8 调整层):
 * deterministic rules R1–R4 (M4) plus R5 (M6, perf pain-point → prioritize); R6
 * is still a no-op hook. Pure: depends only on (base, profile, record, evidence).
 * Caution-raising rules (R3/R4) never touch a security update, so a profile can't
 * bury a security upgrade.
 */
export function applyProfile(
  base: ScoreResult,
  profile: ProjectProfile,
  record: UpdateRecord,
  evidence?: AiEvidence,
): ProfileAdjustment {
  const unchanged = (): ProfileAdjustment => ({ recommendation: base.recommendation, changed: false, reasons: [] });

  // R0: a profile can't unblock something the base blocked.
  if (base.recommendation === 'Blocked') return unchanged();

  // R1: hard_constraints.node not accepted by the latest version → Blocked.
  // (Can add a block the base missed, e.g. stack.json had no engines.node.)
  const profileNode = profile.hard_constraints.node;
  const requiredNode = record.requirements?.node ?? null;
  if (profileNode && !projectNodeAccepted(profileNode, requiredNode)) {
    return {
      recommendation: 'Blocked',
      changed: true,
      reasons: [`hard_constraints.node \`${profileNode}\` is not within the latest version's required \`node: ${requiredNode}\``],
    };
  }

  // Explicit type: the R0 early-return narrowed `base.recommendation` to exclude
  // 'Blocked', but `current` must stay the full union for the floor logic below.
  let current: Recommendation = base.recommendation;
  const reasons: string[] = [];
  const applyFloor = (floor: Recommendation, reason: string): void => {
    if (current === 'Upgrade Now' || current === 'Blocked') return; // fixed endpoints
    if (CAUTION[current] >= CAUTION[floor]) return; // already at/above this caution
    current = floor;
    reasons.push(reason);
  };

  const ut = record.update_type;

  // R2: upgrade_policy.{major|minor|patch} == manual_review → floor at Review First.
  if ((ut === 'major' || ut === 'minor' || ut === 'patch') && profile.upgrade_policy[ut] === 'manual_review') {
    applyFloor('Review First', `upgrade_policy.${ut} = manual_review → held for review`);
  }

  // Caution-raising rules below never apply to a security update (urgency wins).
  if (!record.signals.security) {
    // R3: a peer change in a published library forces downstream consumers to update.
    if (
      (profile.product_type === 'component_library' || profile.product_type === 'sdk') &&
      record.signals.peer_dependency_changed
    ) {
      applyFloor('Watch', `${profile.product_type}: peerDependencies changed — forces downstream consumers to update`);
    }

    // R4 (conservative): hold new majors until the ecosystem settles.
    if (profile.tech_taste === 'conservative' && ut === 'major') {
      applyFloor('Watch', 'conservative tech_taste: new major held to watch');
    }
  }

  // R4 (aggressive): relax a "clean" major (changelog present, no risk signals) one
  // notch to Safe to Upgrade — unless policy mandates manual review (policy wins).
  if (
    current === 'Review First' &&
    profile.tech_taste === 'aggressive' &&
    profile.upgrade_policy.major !== 'manual_review' &&
    isCleanMajor(record)
  ) {
    current = 'Safe to Upgrade';
    reasons.push('aggressive tech_taste: clean major (changelog present, no risk signals) cleared to upgrade');
  }

  // R5 (live since M5/M6): a low-risk release that fixes a current PERFORMANCE pain
  // point is worth prioritizing (PLAN §8: Upgrade Now = "明确修复当前痛点且 risk=low").
  // Guards (codex): require genuine low BASE risk (so an aggressively-relaxed clean
  // major can't sneak to Upgrade Now) and non-irrelevant value (don't prioritize a
  // change relevance proved you don't use). Placed after R2/R3/R4 so floors win.
  if (
    current === 'Safe to Upgrade' &&
    base.risk === 'low' &&
    base.value !== 'none' &&
    !record.signals.security &&
    profile.current_pain_points.some((p) => PERF_PAIN.test(p)) &&
    (evidence?.extracted_signals.performance_improvements.length ?? 0) > 0
  ) {
    current = 'Upgrade Now';
    reasons.push('matches a current performance pain point (release includes performance improvements)');
  }

  // R6 (M-later hook): component_library + experimental-API new feature → value −1.
  // Needs AI to flag experimental APIs; intentionally no-op for now.

  return { recommendation: current, changed: current !== base.recommendation, reasons };
}

/** A major whose only caution driver is the major bump itself — no other risk signal. */
function isCleanMajor(record: UpdateRecord): boolean {
  return (
    record.update_type === 'major' &&
    record.release_notes.length > 0 &&
    !record.signals.security &&
    !record.signals.breaking &&
    !record.signals.deprecation &&
    !record.signals.peer_dependency_changed &&
    !record.signals.node_requirement_changed &&
    !record.signals.browser_requirement_changed
  );
}
