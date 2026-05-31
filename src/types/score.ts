import type { Confidence } from './update.js';

/** A single scoring dimension's level. */
export type Dimension = 'none' | 'low' | 'medium' | 'high';

/** Action recommendation for a dependency update (PLAN §8). */
export type Recommendation =
  | 'Upgrade Now'
  | 'Safe to Upgrade'
  | 'Review First'
  | 'Watch'
  | 'Defer'
  | 'Blocked';

/** The profile adjustment layer's effect on a base score (M4, PLAN §8 调整层). */
export interface ProfileAdjustment {
  /** Recommendation after profile rules; equals the base when no rule fired. */
  recommendation: Recommendation;
  /** Whether the profile changed the recommendation. */
  changed: boolean;
  /** One bullet per rule that fired (empty when unchanged). */
  reasons: string[];
}

/** Result of scoring one update record. `recommendation` is always the BASE. */
export interface ScoreResult {
  recommendation: Recommendation;
  confidence: Confidence;
  urgency: Dimension;
  risk: Dimension;
  value: Dimension;
  /** "Why" bullets for the report. */
  reasons: string[];
  /** Caveats (low confidence, heuristic value, undetermined blocks, ...). */
  caveats: string[];
  /** Present only when a profile was supplied; the final rec is `adjustment.recommendation`. */
  adjustment?: ProfileAdjustment;
}

/** The project's current state, used to decide Blocked. */
export interface ProjectContext {
  /** Declared engines.node of the repo (stack.json runtime.node_engine). */
  nodeEngine: string | null;
  /**
   * Locked versions per workspace: workspace -> (package name -> locked version).
   * Workspace-scoped so a peer mismatch in an unrelated workspace doesn't
   * wrongly Block an upgrade that only touches other workspaces (codex).
   */
  lockedByWorkspace: Map<string, Map<string, string>>;
}
