import semver from 'semver';
import { parse } from 'yaml';
import {
  type HardConstraints,
  type PolicyUpdateType,
  PRODUCT_TYPES,
  type ProjectProfile,
  TECH_TASTES,
  UPGRADE_POLICY_ACTIONS,
  type UpgradePolicy,
  type UpgradePolicyAction,
  USERS_AND_SCALE,
} from '../types/profile.js';

/** Thrown when a profile is missing required fields or has invalid values. */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * Parse + validate a project profile from YAML text (PLAN.md §7). Strict on the
 * classification enums (a wrong value silently skews every recommendation) and
 * on `hard_constraints.node` (it can Block). Lenient elsewhere: missing optional
 * blocks default to neutral values, unknown keys are ignored. Pure/deterministic.
 */
export function parseProfile(yamlText: string): ProjectProfile {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    throw new ProfileError(`Profile is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(raw)) {
    throw new ProfileError('Profile must be a YAML mapping of fields');
  }

  return {
    product_type: asEnum(raw.product_type, PRODUCT_TYPES, 'product_type'),
    users_and_scale: asEnum(raw.users_and_scale, USERS_AND_SCALE, 'users_and_scale'),
    tech_taste: asEnum(raw.tech_taste, TECH_TASTES, 'tech_taste'),
    hard_constraints: parseHardConstraints(raw.hard_constraints),
    current_pain_points: parseStringArray(raw.current_pain_points, 'current_pain_points'),
    upgrade_policy: parseUpgradePolicy(raw.upgrade_policy),
  };
}

/** True if the (raw) profile text still carries init-profile's review markers. */
export function hasUnreviewedMarkers(yamlText: string): boolean {
  return /#\s*NEEDS REVIEW/i.test(yamlText);
}

function parseHardConstraints(value: unknown): HardConstraints {
  if (value === undefined || value === null) {
    return { node: null, browser_support: null, a11y: null, compliance: [] };
  }
  if (!isPlainObject(value)) {
    throw new ProfileError('`hard_constraints` must be a mapping');
  }
  return {
    node: parseNodeConstraint(value.node),
    browser_support: optionalString(value.browser_support, 'hard_constraints.browser_support'),
    a11y: optionalString(value.a11y, 'hard_constraints.a11y'),
    compliance: parseStringArray(value.compliance, 'hard_constraints.compliance'),
  };
}

function parseUpgradePolicy(value: unknown): UpgradePolicy {
  if (value === undefined || value === null) {
    return { major: 'normal_queue', minor: 'normal_queue', patch: 'normal_queue' };
  }
  if (!isPlainObject(value)) {
    throw new ProfileError('`upgrade_policy` must be a mapping');
  }
  const field = (key: PolicyUpdateType): UpgradePolicyAction =>
    value[key] === undefined
      ? 'normal_queue'
      : asEnum(value[key], UPGRADE_POLICY_ACTIONS, `upgrade_policy.${key}`);
  return { major: field('major'), minor: field('minor'), patch: field('patch') };
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProfileError(
      `Missing or invalid \`${field}\`: ${JSON.stringify(value)} (allowed: ${allowed.join(', ')})`,
    );
  }
  return value as T;
}

/** A field that may be a string or be omitted (→ null). Rejects non-string values. */
function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ProfileError(`\`${field}\` must be a string`);
  }
  return value;
}

/**
 * Validate `hard_constraints.node` as a semver range. Blank/whitespace → null
 * (no constraint) rather than silently meaning `*`, which semver.validRange does.
 */
function parseNodeConstraint(value: unknown): string | null {
  const s = optionalString(value, 'hard_constraints.node');
  if (s === null || s.trim() === '') return null;
  if (semver.validRange(s) === null) {
    throw new ProfileError(`Invalid \`hard_constraints.node\`: ${JSON.stringify(s)} is not a semver range`);
  }
  return s;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ProfileError(`\`${field}\` must be a list of strings`);
  }
  return [...value] as string[]; // copy: YAML aliases can share the same array instance
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
