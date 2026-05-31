import type { FeedSource, TrendAiSummary, WatchlistEntry } from '../types/trend.js';
import { SIGNAL_GATE } from './aggregate.js';

export interface RenderWatchlistInput {
  /** Local date label for the report header. */
  asOf: string;
  /** All feeds attempted this run. */
  sources: readonly FeedSource[];
  /** Feeds that failed (from fetchFeeds). */
  failed: { source_id: string; reason: string }[];
  aiUsage: TrendAiSummary;
  /** False when stack.json is missing → Signals are disabled (no relation gate). */
  stackKnown: boolean;
}

/** Emerging tools need at least this many publisher groups to be worth listing (filters one-off noise). */
const EMERGING_MIN_GROUPS = 2;

/**
 * Render `community-watchlist.md` (M9, PLAN §10). INDEPENDENT of the upgrade
 * report — it never affects scoring. Deterministic: `entries` arrive pre-sorted
 * and `asOf` is injected, so identical state yields identical bytes.
 */
export function renderWatchlist(entries: readonly WatchlistEntry[], input: RenderWatchlistInput): string {
  const lines: string[] = [];
  lines.push(`# Stack Radar — Community Watchlist — ${input.asOf}`);
  lines.push('');
  lines.push('_Independent trend signal from community feeds. Does NOT affect upgrade recommendations._');
  lines.push('');
  lines.push(...renderLegend());

  const signals = entries.filter((e) => e.is_signal);
  const emerging = entries.filter((e) => !e.is_signal && e.distinct_source_groups >= EMERGING_MIN_GROUPS);

  lines.push('## 🚨 Signals');
  lines.push('');
  if (!input.stackKnown) {
    lines.push('_Signals are disabled: no stack.json found. Run `stack-radar scan` first, then re-run — showing Emerging only._');
  } else {
    lines.push('_Tools with sustained, independent discussion that relate to your stack._');
    lines.push('');
    if (signals.length === 0) lines.push('_(none)_');
    else for (const e of signals) lines.push(...renderEntry(e, false));
  }
  lines.push('');

  lines.push('## 👀 Emerging');
  lines.push('');
  lines.push('_Gaining attention but not yet a signal._');
  lines.push('');
  if (emerging.length === 0) lines.push('_(none)_');
  else for (const e of emerging) lines.push(...renderEntry(e, true));
  lines.push('');

  lines.push(...renderDataSources(input));
  lines.push(...renderAi(input.aiUsage));
  return `${lines.join('\n')}\n`;
}

/**
 * Reader-facing legend rendered once at the top — without this, the report's
 * jargon (Signal vs Emerging, "publisher group", gate values) is opaque to
 * anyone who hasn't read aggregate.ts. Thresholds are INTERPOLATED from the
 * source-of-truth constants so the prose can't drift from policy.
 */
function renderLegend(): string[] {
  return [
    '## How to read this',
    '',
    "Stack Radar surfaces what the community is discussing that relates to your stack. It's **observation, not a recommendation** — the tool doesn't say to switch; it tells you what's worth a look.",
    '',
    '**Signal** — a tool that passes every gate:',
    `- ≥${SIGNAL_GATE.minSourceGroups} independent **publisher groups** (multiple feeds from the same media company count as one)`,
    `- ≥${SIGNAL_GATE.minWeeks} distinct ISO weeks of mentions (sustained, not a single-day burst)`,
    `- ≥${SIGNAL_GATE.minStories} distinct stories (not the same article echoed around)`,
    '- relates to something in your `stack.json` (substitute or complement)',
    "- not a single release-announcement cluster (one launch isn't a signal)",
    '',
    `**Emerging** — mentioned by ≥${EMERGING_MIN_GROUPS} publisher groups but missing at least one gate. Each entry shows what it lacks under _"Not a signal yet:"_.`,
    '',
    'A single missing source or a feed coverage gap can be the difference between Emerging and Signal — check the **Data source status** section if too few feeds succeeded.',
    '',
  ];
}

function renderEntry(e: WatchlistEntry, emerging: boolean): string[] {
  const out: string[] = [];
  out.push(`### ${e.display_name}`);
  out.push(
    `- ${e.distinct_source_groups} publisher group(s), ${e.total_mentions} mention(s) across ${e.distinct_weeks} week(s), ${e.distinct_stories} story/stories`,
  );
  out.push(e.related_to_stack.length > 0 ? `- Relates to your stack: ${e.related_to_stack.join(', ')}` : '- No direct stack relation');
  out.push(`- First seen ${e.first_seen} · last seen ${e.last_seen}`);
  if (emerging && e.signal_blockers.length > 0) out.push(`- Not a signal yet: ${e.signal_blockers.join('; ')}`);
  out.push('');
  return out;
}

function renderDataSources(input: RenderWatchlistInput): string[] {
  const out: string[] = [];
  out.push('## Data source status');
  out.push('');
  out.push(`- Feeds: ${input.sources.length} attempted, ${input.sources.length - input.failed.length} ok, ${input.failed.length} failed`);
  for (const f of [...input.failed].sort((a, b) => a.source_id.localeCompare(b.source_id))) {
    out.push(`- Failed: ${f.source_id} (${f.reason})`);
  }
  out.push('');
  return out;
}

function renderAi(ai: TrendAiSummary): string[] {
  const out: string[] = [];
  out.push('## AI extraction');
  out.push('');
  if (ai.dry_run) {
    out.push('- AI dry-run: prompts printed, no API calls');
  } else {
    out.push(`- Model: ${ai.model}`);
    out.push(`- Items: ${ai.items} | API calls: ${ai.calls} | from cache: ${ai.cached} | failed: ${ai.errors}`);
    out.push(`- Tokens: ${ai.input_tokens} input / ${ai.output_tokens} output`);
    if (ai.errors > 0) out.push(`- ⚠️ ${ai.errors} item(s) could not be analyzed (provider error) — the watchlist may be incomplete this run`);
  }
  return out;
}
