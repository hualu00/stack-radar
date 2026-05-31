/**
 * Types for the Trend Watcher (M9, PLAN §10) — an INDEPENDENT workflow that
 * watches public community feeds and emits `community-watchlist.md`. It never
 * enters the upgrade scoring (PLAN §2.6). State persists in `.stack-radar/trends.json`.
 */

/**
 * A community feed we poll. `group` is the PUBLISHER — independence is counted
 * by group, so two feeds from the same publisher (e.g. a blog + a release feed)
 * don't count as two independent confirmations of a tool.
 */
export interface FeedSource {
  id: string;
  name: string;
  url: string;
  /** Publisher id; distinct groups = independent confirmations. */
  group: string;
  kind: 'rss';
}

/** A normalized feed entry (one article / release note). */
export interface FeedItem {
  source_id: string;
  source_group: string;
  source_name: string;
  /** Stable identity: canonical link when present, else source_id+title+date. */
  item_key: string;
  /** Article URL (may be empty if the feed omitted it). */
  link: string;
  title: string;
  /** Short text (contentSnippet/summary), whitespace-collapsed and capped; with the title, the only text the AI sees. */
  summary: string;
  /** Publish date as a UTC YYYY-MM-DD, or null when the feed omitted/garbled it. */
  published_at: string | null;
}

/** One tool the AI extracted from a feed item (before local canonicalization). */
export interface ExtractedTool {
  /** Tool name as written in the item. */
  display_name: string;
  /** Optional package/canonical hint the model offers (e.g. "@tanstack/react-query"). */
  canonical_hint?: string;
  /** Verbatim quote from the item proving the mention (anti-fabrication grounding). */
  evidence_quote: string;
}

export interface MentionExtraction {
  tools: ExtractedTool[];
}

/** One persisted mention: a (tool, source, item) observation. */
export interface TrendMention {
  /** Canonical grouping key (lowercased/aliased via relations.ts). */
  tool_key: string;
  /** Human-facing name (first display_name seen for this tool_key). */
  display_name: string;
  source_id: string;
  source_group: string;
  item_key: string;
  item_url: string;
  title: string;
  /** UTC YYYY-MM-DD from the feed, or null. */
  published_at: string | null;
  /** UTC date this mention was first recorded; set once, preserved across reruns. */
  observed_at: string;
}

export interface TrendsFile {
  version: 1;
  mentions: TrendMention[];
}

/** Aggregated view of one tool across all recorded mentions (aggregate.ts). */
export interface WatchlistEntry {
  tool_key: string;
  display_name: string;
  /** Distinct publisher groups mentioning it (independence). */
  distinct_source_groups: number;
  /** Distinct ISO weeks (UTC) it was mentioned in (sustained interest). */
  distinct_weeks: number;
  /** Distinct stories (item_key) — guards against one announcement echoed around. */
  distinct_stories: number;
  total_mentions: number;
  first_seen: string;
  last_seen: string;
  /** Stack items it substitutes/complements (local match); empty = none. */
  related_to_stack: string[];
  /** Why it did NOT clear the signal gate (empty ⇔ is_signal). Drives the Emerging section. */
  signal_blockers: string[];
  /** Cleared the full signal gate — only these are true "Signals". */
  is_signal: boolean;
}

/** Run-level AI summary for the watchlist appendix (M9 analogue of AiRunSummary). */
export interface TrendAiSummary {
  model: string;
  /** Feed items sent through extraction (incl. cached / degraded). */
  items: number;
  /** Real API calls (excludes cache hits + dry-run). */
  calls: number;
  cached: number;
  /** Items whose extraction degraded (provider error) — surfaced as a warning. */
  errors: number;
  input_tokens: number;
  output_tokens: number;
  dry_run: boolean;
}

export function emptyTrendsFile(): TrendsFile {
  return { version: 1, mentions: [] };
}
