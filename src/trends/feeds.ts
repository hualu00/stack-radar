import Parser from 'rss-parser';
import { mapWithConcurrency } from '../utils/concurrency.js';
import type { Fetcher } from '../utils/http.js';
import type { FeedItem, FeedSource } from '../types/trend.js';

/**
 * First-batch community feeds (PLAN §10). Newsletters + project release feeds.
 * `group` is the publisher: independence in the signal gate is counted by group,
 * so a project's blog and its release feed never double-confirm. GitHub release
 * `.atom` URLs are stable; newsletter URLs are best-effort and easy to tune.
 */
export const FEED_SOURCES: readonly FeedSource[] = [
  { id: 'javascript-weekly', name: 'JavaScript Weekly', url: 'https://javascriptweekly.com/rss', group: 'cooperpress', kind: 'rss' },
  { id: 'frontend-focus', name: 'Frontend Focus', url: 'https://frontendfoc.us/rss', group: 'cooperpress', kind: 'rss' },
  { id: 'this-week-in-react', name: 'This Week in React', url: 'https://thisweekinreact.com/feed', group: 'thisweekinreact', kind: 'rss' },
  // Bytes (bytes.dev) — no official RSS feed; removed.
  // Vercel Changelog — full-company atom feed > 2 MB cap and too broad; removed (track per-project release feeds instead).
  // VoidZero ecosystem (Evan You's company; one publisher, four projects). One group
  // so a tool mentioned in multiple VoidZero project release notes counts as ONE
  // independent confirmation, not four — the spec's "independent sources" gate is
  // about distinct publishers, not distinct repos. voidzero.dev/blog itself has
  // no public RSS feed (only a newsletter), so we cover them via the release atoms.
  { id: 'vite-releases', name: 'Vite Releases', url: 'https://github.com/vitejs/vite/releases.atom', group: 'voidzero', kind: 'rss' },
  { id: 'vitest-releases', name: 'Vitest Releases', url: 'https://github.com/vitest-dev/vitest/releases.atom', group: 'voidzero', kind: 'rss' },
  { id: 'rolldown-releases', name: 'Rolldown Releases', url: 'https://github.com/rolldown/rolldown/releases.atom', group: 'voidzero', kind: 'rss' },
  { id: 'oxc-releases', name: 'Oxc Releases', url: 'https://github.com/oxc-project/oxc/releases.atom', group: 'voidzero', kind: 'rss' },
  { id: 'tanstack-query-releases', name: 'TanStack Query Releases', url: 'https://github.com/TanStack/query/releases.atom', group: 'tanstack', kind: 'rss' },
  { id: 'biome-releases', name: 'Biome Releases', url: 'https://github.com/biomejs/biome/releases.atom', group: 'biome', kind: 'rss' },
  { id: 'github-trending-js', name: 'GitHub Trending (JavaScript)', url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/javascript.xml', group: 'github-trending', kind: 'rss' },
  { id: 'github-trending-ts', name: 'GitHub Trending (TypeScript)', url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/typescript.xml', group: 'github-trending', kind: 'rss' },
];

const SUMMARY_CAP = 600;
/** Reject absurdly large feeds before parsing (memory + downstream prompt size). */
const MAX_FEED_BYTES = 2_000_000;
const FETCH_CONCURRENCY = 4;
/** Query params that are tracking noise, never story identity — dropped in item_key. */
const TRACKING_PARAMS = new Set(['ref', 'source', 'fbclid', 'gclid', 'mc_cid', 'mc_eid']);
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

export interface FetchFeedsResult {
  items: FeedItem[];
  /** Feeds that could not be fetched/parsed; the run continues without them. */
  failed: { source_id: string; reason: string }[];
}

/**
 * Fetch + parse every feed through the INJECTABLE `Fetcher` (rss-parser only
 * parses the returned XML string — it never does its own network, so tests stay
 * offline). Per-feed failure degrades into `failed` and never aborts the run.
 */
export async function fetchFeeds(
  fetcher: Fetcher,
  sources: readonly FeedSource[] = FEED_SOURCES,
  options: { concurrency?: number } = {},
): Promise<FetchFeedsResult> {
  const results = await mapWithConcurrency(
    [...sources],
    options.concurrency ?? FETCH_CONCURRENCY,
    async (source): Promise<{ source: FeedSource; items?: FeedItem[]; error?: string }> => {
      try {
        const res = await fetcher(source.url, { headers: { accept: FEED_ACCEPT } });
        if (!res.ok) return { source, error: `HTTP ${res.status}` };
        const xml = await res.text();
        if (xml.length > MAX_FEED_BYTES) return { source, error: `feed too large (${xml.length} bytes)` };
        // Parser per task: no shared mutable state across the concurrent fetches.
        const parsed = await new Parser().parseString(xml);
        const items = (parsed.items ?? [])
          .map((raw) => normalizeItem(source, raw))
          .filter((i): i is FeedItem => i !== null);
        return { source, items };
      } catch (err) {
        return { source, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  const items: FeedItem[] = [];
  const failed: { source_id: string; reason: string }[] = [];
  for (const r of results) {
    if (r.error !== undefined) failed.push({ source_id: r.source.id, reason: r.error });
    else items.push(...(r.items ?? []));
  }
  return { items, failed };
}

/** Normalize one raw rss-parser item; returns null for an item with no title (nothing to extract). */
function normalizeItem(
  source: FeedSource,
  raw: { title?: string; link?: string; isoDate?: string; pubDate?: string; contentSnippet?: string; summary?: string; content?: string },
): FeedItem | null {
  const title = (raw.title ?? '').trim();
  if (title === '') return null;
  const link = (raw.link ?? '').trim();
  const published_at = toUtcDate(raw.isoDate ?? raw.pubDate);
  const summary = capSummary(raw.contentSnippet ?? raw.summary ?? raw.content ?? '');
  return {
    source_id: source.id,
    source_group: source.group,
    source_name: source.name,
    item_key: stableItemKey(source.id, link, title, published_at),
    link,
    title,
    summary,
    published_at,
  };
}

/** Parse any feed timestamp into a UTC YYYY-MM-DD; null when absent/unparseable. */
export function toUtcDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

/**
 * Stable per-story identity: the canonical link when present (RSS GUIDs are
 * unreliable), else a synthetic key from source + normalized title + date.
 */
export function stableItemKey(sourceId: string, link: string, title: string, publishedAt: string | null): string {
  if (link !== '') return canonicalUrl(link);
  return `${sourceId}::${normalizeText(title).toLowerCase()}::${publishedAt ?? 'nodate'}`;
}

/**
 * Canonicalize a story URL into a stable identity: lowercase host, strip the
 * hash and tracking params (utm_*, ref, fbclid, …), but PRESERVE the remaining
 * query params (sorted) — some feeds put the permalink id in the query (?issue=,
 * ?p=, ?id=), so dropping all of them would merge distinct stories.
 */
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !(k.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(k.toLowerCase())))
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const base = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`.replace(/\/+$/, '');
    const query = kept.map(([k, v]) => `${k}=${v}`).join('&');
    return query ? `${base}?${query}` : base;
  } catch {
    return url.trim();
  }
}

function capSummary(text: string): string {
  const t = normalizeText(text);
  return t.length > SUMMARY_CAP ? t.slice(0, SUMMARY_CAP) : t;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
