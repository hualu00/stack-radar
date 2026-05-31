/**
 * Types for `.stack-radar/project-profile.yaml` — the project profile that
 * drives the M4 adjustment layer (PLAN.md §7). Kept ≤ ~30 lines on disk.
 *
 * Enum value lists are the single source of truth: the string-literal types are
 * derived from them so validation (scoring/profile.ts) and the types never drift.
 */

export const PRODUCT_TYPES = ['component_library', 'business_app', 'internal_tool', 'sdk'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const USERS_AND_SCALE = ['internal', 'high_traffic_consumer', 'enterprise_b2b'] as const;
export type UsersAndScale = (typeof USERS_AND_SCALE)[number];

export const TECH_TASTES = ['conservative', 'mainstream', 'aggressive'] as const;
export type TechTaste = (typeof TECH_TASTES)[number];

export const UPGRADE_POLICY_ACTIONS = ['manual_review', 'normal_queue', 'auto_candidate'] as const;
export type UpgradePolicyAction = (typeof UPGRADE_POLICY_ACTIONS)[number];

/** The update types a policy can be declared for (prerelease has no policy). */
export const POLICY_UPDATE_TYPES = ['major', 'minor', 'patch'] as const;
export type PolicyUpdateType = (typeof POLICY_UPDATE_TYPES)[number];

/** Hard limits the project cannot cross. `node` participates in Blocked scoring. */
export interface HardConstraints {
  /** A semver range the project must keep supporting (e.g. ">=18"); null when none. */
  node: string | null;
  /** Free text (e.g. "Chrome 100+, Safari 15+"); not yet used in scoring. */
  browser_support: string | null;
  /** Free text (e.g. "WCAG 2.1 AA"); not yet used in scoring. */
  a11y: string | null;
  /** Free-text compliance tags; not yet used in scoring. */
  compliance: string[];
}

/** Per-update-type upgrade policy. */
export interface UpgradePolicy {
  major: UpgradePolicyAction;
  minor: UpgradePolicyAction;
  patch: UpgradePolicyAction;
}

/** A fully-parsed, validated project profile. */
export interface ProjectProfile {
  product_type: ProductType;
  users_and_scale: UsersAndScale;
  tech_taste: TechTaste;
  hard_constraints: HardConstraints;
  current_pain_points: string[];
  upgrade_policy: UpgradePolicy;
}
