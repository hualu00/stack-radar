import { join } from 'node:path';
import semver from 'semver';
import {
  DECISION_ACTIONS,
  type Decision,
  type DecisionsFile,
  emptyDecisionsFile,
} from '../types/decision.js';
import { fileExists, readText, writeJson } from '../utils/fs.js';

/** The only keys a decision may carry; anything else is a typo we must catch. */
const DECISION_KEYS = new Set(['package', 'action', 'version_range', 'reason', 'until', 'created_at']);

/** Thrown when decisions.json (or a feedback input) is structurally invalid. */
export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionError';
  }
}

/** True for a real calendar date in strict `YYYY-MM-DD` form (rejects 2026-13-40). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * True only for a canonical ISO instant (exactly what `new Date().toISOString()`
 * emits, e.g. `2026-05-27T10:00:00.000Z`). Stricter than `Date.parse` (which
 * accepts junk like "123"); `created_at` drives newest-wins precedence, so it
 * must be a stable, comparable, round-trippable format.
 */
export function isIsoInstant(value: string): boolean {
  const t = Date.parse(value);
  return !Number.isNaN(t) && new Date(t).toISOString() === value;
}

/** Stable identity for upsert/dedup: a decision is unique per (package, range). */
export function decisionKey(d: Pick<Decision, 'package' | 'version_range'>): string {
  return `${d.package}@@${d.version_range ?? ''}`;
}

/**
 * Validate + normalize one decision (shared by `parseDecisions` and the `feedback`
 * command, so a hand-edited file and CLI input obey identical invariants):
 * non-empty package, valid action, valid `created_at`, semver `version_range`,
 * and the snooze⇔until coupling (snooze requires a real `YYYY-MM-DD`; the others
 * forbid `until`). Pure; throws `DecisionError`.
 */
export function validateDecision(raw: unknown, where = 'decision'): Decision {
  if (!isPlainObject(raw)) throw new DecisionError(`${where} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!DECISION_KEYS.has(key)) {
      throw new DecisionError(`${where} has unknown key \`${key}\` (a typo here silently changes the decision's meaning)`);
    }
  }

  const pkg = raw.package;
  if (typeof pkg !== 'string' || pkg.trim() === '') {
    throw new DecisionError(`${where}.package must be a non-empty string`);
  }
  const action = raw.action;
  if (typeof action !== 'string' || !DECISION_ACTIONS.includes(action as Decision['action'])) {
    throw new DecisionError(`${where}.action must be one of: ${DECISION_ACTIONS.join(', ')} (got ${JSON.stringify(action)})`);
  }
  const created_at = raw.created_at;
  if (typeof created_at !== 'string' || !isIsoInstant(created_at)) {
    throw new DecisionError(`${where}.created_at must be a canonical ISO instant (e.g. 2026-05-27T10:00:00.000Z)`);
  }

  // Store the trimmed name — a stray-space package would never match record.name.
  const decision: Decision = { package: pkg.trim(), action: action as Decision['action'], created_at };

  if (raw.version_range !== undefined) {
    if (typeof raw.version_range !== 'string') {
      throw new DecisionError(`${where}.version_range must be a string`);
    }
    const range = raw.version_range.trim();
    const normalized = semver.validRange(range);
    if (range === '' || normalized === null) {
      throw new DecisionError(`${where}.version_range must be a valid semver range (got ${JSON.stringify(raw.version_range)})`);
    }
    if (normalized === '*') {
      throw new DecisionError(`${where}.version_range \`${range}\` matches every version — omit version_range for a package-wide decision`);
    }
    decision.version_range = range;
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') throw new DecisionError(`${where}.reason must be a string`);
    decision.reason = raw.reason;
  }

  if (action === 'snooze') {
    if (typeof raw.until !== 'string' || !isIsoDate(raw.until)) {
      throw new DecisionError(`${where}: a snooze requires \`until\` as a YYYY-MM-DD date (got ${JSON.stringify(raw.until)})`);
    }
    decision.until = raw.until;
  } else if (raw.until !== undefined) {
    throw new DecisionError(`${where}: \`until\` is only valid for a snooze, not \`${action}\``);
  }

  return decision;
}

/**
 * Parse + validate a whole decisions file. Strict: version must be 1, every
 * decision valid, and no two decisions share a (package, version_range) key
 * (the upsert invariant — a duplicate means the file was hand-corrupted).
 */
export function parseDecisions(raw: unknown): DecisionsFile {
  if (!isPlainObject(raw)) throw new DecisionError('decisions.json must be an object');
  if (raw.version !== 1) throw new DecisionError(`decisions.json version must be 1 (got ${JSON.stringify(raw.version)})`);
  if (!Array.isArray(raw.decisions)) throw new DecisionError('decisions.json `decisions` must be an array');

  const decisions = raw.decisions.map((d, i) => validateDecision(d, `decisions[${i}]`));
  const seen = new Set<string>();
  for (const d of decisions) {
    const key = decisionKey(d);
    if (seen.has(key)) throw new DecisionError(`decisions.json has duplicate decisions for ${key}`);
    seen.add(key);
  }
  return { version: 1, decisions };
}

/**
 * Load `.stack-radar/decisions.json`. A MISSING file is normal → empty set.
 * A present-but-malformed file THROWS (unlike `readJson`, which would null both
 * cases and silently discard a broken file the user spent effort on).
 */
export function loadDecisions(repoPath: string): DecisionsFile {
  const path = join(repoPath, '.stack-radar', 'decisions.json');
  if (!fileExists(path)) return emptyDecisionsFile(); // missing is normal
  const text = readText(path);
  if (text === null) throw new DecisionError(`decisions.json exists but could not be read: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DecisionError(`decisions.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseDecisions(raw);
}

/**
 * Append or replace a decision by (package, version_range): a new judgement on
 * the same package+range supersedes the old one (so `accept` can clear a prior
 * `snooze`). Returns a new, deterministically sorted file (stable diffs).
 */
export function upsertDecision(file: DecisionsFile, decision: Decision): DecisionsFile {
  const key = decisionKey(decision);
  const kept = file.decisions.filter((d) => decisionKey(d) !== key);
  kept.push(decision);
  return { version: 1, decisions: sortDecisions(kept) };
}

/** Persist a decisions file (pretty JSON via the shared writer). */
export function writeDecisions(repoPath: string, file: DecisionsFile): void {
  writeJson(join(repoPath, '.stack-radar', 'decisions.json'), { version: 1, decisions: sortDecisions(file.decisions) });
}

function sortDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort(
    (a, b) =>
      a.package.localeCompare(b.package) ||
      (a.version_range ?? '').localeCompare(b.version_range ?? '') ||
      a.action.localeCompare(b.action) ||
      a.created_at.localeCompare(b.created_at),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
