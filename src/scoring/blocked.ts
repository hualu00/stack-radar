import semver from 'semver';
import type { ProjectContext } from '../types/score.js';
import type { Requirements } from '../types/update.js';

export interface BlockedResult {
  blocked: boolean;
  /** Concrete reasons the upgrade is blocked (node/peer not satisfied). */
  reasons: string[];
  /** Notes where compatibility couldn't be determined. */
  caveats: string[];
  /** Required (non-optional) peers absent from the project — a risk bump, not a block. */
  missingPeers: string[];
}

/**
 * Decide whether upgrading to `latest` is blocked by the project's declared
 * Node engine or its locked peer versions. Only the workspaces where this
 * package is used (plus the root, for hoisted peers) are considered, so an
 * unrelated workspace can't wrongly block (codex). Undetermined cases never
 * block — they become caveats.
 */
export function evaluateBlocked(
  requirements: Requirements | undefined,
  workspaces: string[],
  ctx: ProjectContext,
): BlockedResult {
  const reasons: string[] = [];
  const caveats: string[] = [];
  const missingPeers: string[] = [];
  // Workspaces where this package is actually used (root for a non-workspace dep).
  const instanceWorkspaces = workspaces.length > 0 ? [...new Set(workspaces)] : ['.'];

  const reqNode = requirements?.node ?? null;
  if (reqNode && reqNode !== '*') {
    if (!ctx.nodeEngine) {
      caveats.push("Project's Node engine is unspecified — Node compatibility not evaluated");
    } else if (isWildcard(ctx.nodeEngine)) {
      caveats.push("Project's Node engine is `*` (any) — Node compatibility not evaluated");
    } else if (!isValidRange(ctx.nodeEngine) || !isValidRange(reqNode)) {
      caveats.push('Could not evaluate Node compatibility (unparseable engines.node range)');
    } else if (!projectNodeAccepted(ctx.nodeEngine, reqNode)) {
      reasons.push(`Project Node \`${ctx.nodeEngine}\` is not within the latest version's required \`node: ${reqNode}\``);
    }
  }

  const peers = requirements?.peers ?? {};
  const optional = new Set(requirements?.optional_peers ?? []);
  for (const [name, range] of Object.entries(peers)) {
    if (optional.has(name)) continue;
    if (typeof range !== 'string' || !isValidRange(range)) {
      caveats.push(`Could not evaluate peer \`${name}\` (unparseable range)`);
      continue;
    }
    // Effective peer version per workspace: local install wins, else root (hoist).
    const root = ctx.lockedByWorkspace.get('.')?.get(name);
    const effective: string[] = [];
    for (const ws of instanceWorkspaces) {
      const version = ctx.lockedByWorkspace.get(ws)?.get(name) ?? root;
      if (version) effective.push(version);
    }
    if (effective.length === 0) {
      missingPeers.push(name);
      continue;
    }
    const failing = effective.find((v) => !satisfiesSafe(v, range));
    if (failing) {
      reasons.push(`Peer \`${name}\` requires \`${range}\` but the project has \`${failing}\``);
    }
  }

  return { blocked: reasons.length > 0, reasons, caveats, missingPeers };
}

/**
 * Is `projectRange` ⊆ `requiredRange`? i.e. is every Node version the project
 * allows accepted by the package's required range? Undetermined inputs
 * (null / `*` / unparseable) return `true` — "can't confirm a violation, so don't
 * block." Shared by `evaluateBlocked` (engines.node) and the M4 profile layer
 * (`hard_constraints.node`) so both use identical semver semantics.
 */
export function projectNodeAccepted(projectRange: string | null, requiredRange: string | null): boolean {
  if (!requiredRange || requiredRange === '*' || !projectRange) return true;
  if (isWildcard(projectRange)) return true;
  if (!isValidRange(projectRange) || !isValidRange(requiredRange)) return true;
  return subsetSafe(projectRange, requiredRange);
}

function isValidRange(range: string): boolean {
  return semver.validRange(range) !== null;
}

/** A range that allows any version (`*`, ``, `x`) — can't confirm compatibility. */
function isWildcard(range: string): boolean {
  return semver.validRange(range) === '*';
}

/** project ⊆ required? (every Node version the project allows is accepted by the new package) */
function subsetSafe(projectRange: string, requiredRange: string): boolean {
  try {
    return semver.subset(projectRange, requiredRange);
  } catch {
    return true; // can't determine -> don't block
  }
}

function satisfiesSafe(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return true; // can't determine -> don't block
  }
}
