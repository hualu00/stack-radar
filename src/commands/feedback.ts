import { resolve } from 'node:path';
import type { Decision, DecisionAction } from '../types/decision.js';
import { loadDecisions, upsertDecision, validateDecision, writeDecisions } from '../decisions/store.js';

export interface FeedbackOptions {
  repo: string;
  /** Package name, matched against name AND resolved_name at recommend time. */
  package: string;
  action: DecisionAction;
  /** Optional semver range scoping the decision (e.g. "19.x"). */
  versionRange?: string;
  /** Snooze end date (YYYY-MM-DD). Required for snooze, rejected otherwise. */
  until?: string;
  reason?: string;
  /** Injected `created_at` for deterministic tests; defaults to now (ISO). */
  now?: string;
}

/**
 * Record a feedback decision into `.stack-radar/decisions.json` (PLAN §11, M7).
 * Builds the decision from CLI input, runs it through the SAME validator the
 * file parser uses (so CLI input and on-disk files obey identical invariants),
 * then upserts by (package, version_range) — a new judgement on the same
 * package+range supersedes the prior one. Deterministic, no AI.
 */
export function runFeedback(options: FeedbackOptions): void {
  const repoPath = resolve(options.repo);

  // Build the raw shape and validate (throws DecisionError on bad action/until/range).
  const built: Record<string, unknown> = {
    package: options.package,
    action: options.action,
    created_at: options.now ?? new Date().toISOString(),
  };
  if (options.versionRange !== undefined) built.version_range = options.versionRange;
  if (options.reason !== undefined) built.reason = options.reason;
  if (options.until !== undefined) built.until = options.until;
  const decision: Decision = validateDecision(built, 'feedback');

  const updated = upsertDecision(loadDecisions(repoPath), decision);
  writeDecisions(repoPath, updated);

  const scope = decision.version_range ? ` (${decision.version_range})` : '';
  const extra = decision.action === 'snooze' ? ` until ${decision.until}` : '';
  console.log(`Recorded: ${decision.action} ${decision.package}${scope}${extra}`);
  console.log(`  -> ${repoPath}/.stack-radar/decisions.json (${updated.decisions.length} decision(s))`);
}
