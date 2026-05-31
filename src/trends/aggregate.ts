import type { TrendMention, WatchlistEntry } from '../types/trend.js';
import { relateToStack } from './relations.js';

/**
 * Aggregate stored mentions into a watchlist (M9, PLAN §10). PURE + deterministic.
 * Product policy lives HERE, not in the store: independence is counted by
 * publisher group, "sustained" by distinct ISO weeks, and a release-cluster spike
 * guard keeps a single announcement (echoed by a few outlets) out of Signals.
 */

/**
 * A tool is a true Signal only if it clears every gate. Exported as the single
 * source of truth so the watchlist legend interpolates the same numbers used by
 * the gate code (prose can't drift from policy).
 */
export const SIGNAL_GATE = {
  minSourceGroups: 3,
  minWeeks: 2,
  minStories: 2,
} as const;

/** Tokens that mark a story as an announcement/release rather than ongoing discussion. */
const RELEASE_RE = /\b(release[sd]?|announc(?:e|ing|ement)|launch(?:ed|ing)?)\b|releases\/tag|\bv?\d+\.\d+(?:\.\d+)?\b/i;

export interface AggregateOptions {
  /** Stack package names (local match only — never sent to AI). */
  stackNames: readonly string[];
  /** Report date (LOCAL YYYY-MM-DD — matches the watchlist label); mentions
   *  dated after it are excluded so a scheduled run is reproducible regardless
   *  of when it executes. Feed dates + ISO-week buckets stay UTC. */
  asOf: string;
}

export function aggregate(mentions: readonly TrendMention[], options: AggregateOptions): WatchlistEntry[] {
  const byTool = new Map<string, TrendMention[]>();
  for (const m of mentions) {
    if (effectiveDate(m) > options.asOf) continue; // ignore future-dated mentions
    const list = byTool.get(m.tool_key) ?? [];
    list.push(m);
    byTool.set(m.tool_key, list);
  }

  const entries: WatchlistEntry[] = [];
  for (const [tool_key, list] of byTool) {
    const dates = list.map(effectiveDate);
    const groups = new Set(list.map((m) => m.source_group));
    const weeks = new Set(dates.map(isoWeekKey));
    const stories = new Set(list.map((m) => m.item_key));
    const related = relateToStack(tool_key, options.stackNames);

    // A tool is a Signal iff nothing blocks it; the blockers double as the
    // human-readable "why it's only Emerging" explanation in the report.
    const blockers: string[] = [];
    if (groups.size < SIGNAL_GATE.minSourceGroups) blockers.push(`needs ≥${SIGNAL_GATE.minSourceGroups} publisher groups (have ${groups.size})`);
    if (weeks.size < SIGNAL_GATE.minWeeks) blockers.push(`needs ≥${SIGNAL_GATE.minWeeks} active weeks (have ${weeks.size})`);
    if (stories.size < SIGNAL_GATE.minStories) blockers.push(`needs ≥${SIGNAL_GATE.minStories} distinct stories (have ${stories.size})`);
    if (related.length === 0) blockers.push('no related stack dependency (not in your stack, and not a known substitute or complement of anything in it)');
    if (isReleaseSpike(list)) blockers.push('single release announcement (not sustained discussion)');

    entries.push({
      tool_key,
      display_name: list[0]?.display_name ?? tool_key,
      distinct_source_groups: groups.size,
      distinct_weeks: weeks.size,
      distinct_stories: stories.size,
      total_mentions: list.length,
      first_seen: dates.reduce((a, b) => (a < b ? a : b)),
      last_seen: dates.reduce((a, b) => (a > b ? a : b)),
      related_to_stack: related,
      signal_blockers: blockers,
      is_signal: blockers.length === 0,
    });
  }

  // Strongest first, with a unique tool_key tiebreak → fully deterministic order.
  return entries.sort(
    (a, b) =>
      Number(b.is_signal) - Number(a.is_signal) ||
      b.distinct_source_groups - a.distinct_source_groups ||
      b.distinct_weeks - a.distinct_weeks ||
      b.total_mentions - a.total_mentions ||
      a.tool_key.localeCompare(b.tool_key),
  );
}

/** Week math runs on the date the feed published (or, lacking that, when we first saw it). */
function effectiveDate(m: TrendMention): string {
  return m.published_at ?? m.observed_at;
}

/**
 * A release spike = every mention is an announcement/release AND they all collapse
 * to one version/title cluster — i.e. one launch echoed around, not sustained
 * independent interest. Such tools are held out of Signals (still listed Emerging).
 */
function isReleaseSpike(mentions: readonly TrendMention[]): boolean {
  if (!mentions.every((m) => RELEASE_RE.test(m.title) || RELEASE_RE.test(m.item_url))) return false;
  return new Set(mentions.map(clusterKey)).size === 1;
}

/**
 * Cluster a release story by its version token (from the title OR the URL, e.g.
 * `/releases/tag/v2.0.0`), else its normalized title — so three outlets linking
 * the same tagged release collapse to one cluster even with different headlines.
 */
function clusterKey(m: TrendMention): string {
  const version = m.title.match(VERSION_RE)?.[0] ?? m.item_url.match(VERSION_RE)?.[0];
  return (version ?? m.title).toLowerCase().replace(/\s+/g, ' ').trim();
}

const VERSION_RE = /v?\d+\.\d+(?:\.\d+)?/i;

/**
 * ISO-8601 week key (UTC), e.g. "2026-W01". Uses the ISO week-YEAR (from the
 * week's Thursday), so dates straddling New Year bucket correctly. Input is a
 * UTC YYYY-MM-DD.
 */
export function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dayMonFirst = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayMonFirst + 3); // shift to the week's Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDayMonFirst = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayMonFirst + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}
