import { join, resolve } from 'node:path';
import { DEFAULT_AI_MODEL } from '../ai/client.js';
import type { LlmPrompt } from '../ai/transport.js';
import { aggregate } from '../trends/aggregate.js';
import { type TrendExtractor, createTrendExtractor } from '../trends/extract.js';
import { FEED_SOURCES, fetchFeeds } from '../trends/feeds.js';
import { canonicalToolKey } from '../trends/relations.js';
import { loadTrendStore } from '../trends/store.js';
import { renderWatchlist } from '../trends/watchlist.js';
import type { StackJson } from '../types/stack.js';
import type { FeedItem, FeedSource, TrendAiSummary, TrendMention } from '../types/trend.js';
import { Cache } from '../utils/cache.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { readJson, writeText } from '../utils/fs.js';
import { type Fetcher, defaultFetcher } from '../utils/http.js';

const EXTRACT_CONCURRENCY = 4;

export interface WatchTrendsOptions {
  repo: string;
  /** Report-label date + future-clip threshold (LOCAL YYYY-MM-DD); defaults to local today. Injectable for tests. */
  asOf?: string;
  /** observed_at stamped on NEW mentions (UTC YYYY-MM-DD, used in week math); defaults to UTC today. */
  now?: string;
  /** Print extraction prompts without calling the API or touching the cache. */
  dryRun?: boolean;
  /** Re-extract even when a cached extraction exists. */
  refresh?: boolean;
  aiModel?: string;
  /** Write the watchlist to this exact path instead of community-watchlist.md. */
  out?: string;
  // ---- test seams (offline) ----
  fetcher?: Fetcher;
  sources?: readonly FeedSource[];
  extractor?: TrendExtractor;
}

/**
 * `watch-trends` (M9, PLAN §10): poll community feeds, AI-extract mentioned tools
 * from PUBLIC feed text only, record a time-series in trends.json, and emit
 * community-watchlist.md. INDEPENDENT of the upgrade report — never affects
 * scoring. Stack names are used only for LOCAL relation matching (never sent to AI).
 */
export async function runWatchTrends(options: WatchTrendsOptions): Promise<void> {
  const repoPath = resolve(options.repo);
  // Report/clip date is LOCAL (an evening run shouldn't read as "tomorrow"); feed
  // dates and ISO-week buckets stay UTC. observed_at is UTC (it's part of week math).
  const asOf = options.asOf ?? localToday();
  const now = options.now ?? utcToday();
  const model = options.aiModel ?? DEFAULT_AI_MODEL;

  const stack = readJson<StackJson>(join(repoPath, '.stack-radar', 'stack.json'));
  const hasStack = stack !== null && Array.isArray(stack.items);
  const stackNames = hasStack ? unique(stack.items.map((i) => i.name)) : [];
  if (!hasStack) {
    console.error('WARNING: no .stack-radar/stack.json — Signals are disabled (every trend stays Emerging). Run `stack-radar scan` first.');
  }

  // Fast-fail on a missing key BEFORE any network, unless dry-run / injected.
  if (!options.dryRun && !options.extractor && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — required for `watch-trends` (or use --dry-run).');
  }

  const sources = options.sources ?? FEED_SOURCES;
  const { items, failed } = await fetchFeeds(options.fetcher ?? defaultFetcher, sources);

  const extractor =
    options.extractor ??
    createTrendExtractor({
      model,
      cache: new Cache(join(repoPath, '.stack-radar', 'cache')),
      dryRun: options.dryRun,
      refresh: options.refresh,
      onDryRun: printPrompt,
    });

  // dry-run keeps prompt output ordered; otherwise bound the API/subprocess fan-out.
  const concurrency = options.dryRun ? 1 : EXTRACT_CONCURRENCY;
  const results = await mapWithConcurrency(items, concurrency, async (item) => ({ item, res: await extractor.extract(item) }));

  const mentions: TrendMention[] = [];
  let calls = 0;
  let cached = 0;
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const { item, res } of results) {
    if (res.status === 'cached') cached += 1;
    if (res.status === 'error') errors += 1;
    if (res.usage) {
      calls += 1;
      inputTokens += res.usage.input_tokens;
      outputTokens += res.usage.output_tokens;
    }
    for (const tool of res.tools) {
      mentions.push({
        tool_key: canonicalToolKey(tool.display_name, tool.canonical_hint),
        display_name: tool.display_name,
        source_id: item.source_id,
        source_group: item.source_group,
        item_key: item.item_key,
        item_url: item.link,
        title: item.title,
        published_at: item.published_at,
        observed_at: now,
      });
    }
  }

  const store = loadTrendStore(repoPath);
  const added = store.recordMentions(mentions);
  const entries = aggregate(store.mentions(), { stackNames, asOf });

  const aiUsage: TrendAiSummary = {
    model,
    items: items.length,
    calls,
    cached,
    errors,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    dry_run: options.dryRun === true,
  };
  const outPath = options.out ? resolve(options.out) : join(repoPath, '.stack-radar', 'community-watchlist.md');
  writeText(outPath, renderWatchlist(entries, { asOf, sources, failed, aiUsage, stackKnown: hasStack }));

  const signals = entries.filter((e) => e.is_signal).length;
  console.log(`Watch-trends: ${items.length} item(s) from ${sources.length - failed.length}/${sources.length} feed(s)`);
  if (failed.length > 0) console.log(`  Feeds failed: ${failed.length}`);
  console.log(
    options.dryRun
      ? `  AI: dry-run (no calls), model ${model}`
      : `  AI: ${model} — ${calls} calls, ${cached} cached, ${errors} failed, ${inputTokens}/${outputTokens} tok`,
  );
  console.log(`  Mentions: +${added} new (${store.mentions().length} total)`);
  console.log(`  Signals: ${signals} | Watchlist entries: ${entries.length}`);
  console.log(`  -> ${outPath}`);
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Dry-run prompt printer (stdout, so it can be redirected for a privacy audit). */
function printPrompt(item: FeedItem, prompt: LlmPrompt): void {
  console.log(`\n===== TREND PROMPT: ${item.source_id} ${item.item_key} =====`);
  console.log('--- system ---');
  console.log(prompt.system);
  console.log('--- user ---');
  console.log(prompt.user);
}
