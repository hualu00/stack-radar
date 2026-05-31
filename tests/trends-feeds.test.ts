import { describe, expect, it } from 'vitest';
import { FEED_SOURCES, fetchFeeds, stableItemKey, toUtcDate } from '../src/trends/feeds.js';
import type { FeedSource } from '../src/types/trend.js';
import type { Fetcher } from '../src/utils/http.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>JavaScript Weekly</title>
<item>
  <title>Vite 6 released</title>
  <link>https://javascriptweekly.com/issues/700?utm_source=rss#vite</link>
  <pubDate>Tue, 20 May 2026 10:00:00 GMT</pubDate>
  <description>Vite 6 is out with a faster bundler.</description>
</item>
<item>
  <title>A linkless blurb</title>
  <pubDate>Wed, 21 May 2026 10:00:00 GMT</pubDate>
  <description>Something with no link.</description>
</item>
<item>
  <pubDate>Thu, 22 May 2026 10:00:00 GMT</pubDate>
  <description>No title, should be dropped.</description>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Release notes from vite</title>
<entry>
  <title>v6.0.0</title>
  <link href="https://github.com/vitejs/vite/releases/tag/v6.0.0"/>
  <updated>2026-05-19T12:00:00Z</updated>
  <content>Vite 6 release with Environment API.</content>
</entry>
</feed>`;

const sources: FeedSource[] = [
  { id: 'jsw', name: 'JavaScript Weekly', url: 'https://feeds.test/jsw', group: 'cooperpress', kind: 'rss' },
  { id: 'vite', name: 'Vite Releases', url: 'https://feeds.test/vite', group: 'vite', kind: 'rss' },
];

function fakeFetcher(map: Record<string, { status?: number; body?: string; fail?: boolean }>): Fetcher {
  return async (url) => {
    const entry = map[url];
    if (!entry || entry.fail) throw new Error('network down');
    const status = entry.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => entry.body ?? '',
      json: async () => JSON.parse(entry.body ?? 'null'),
    };
  };
}

describe('fetchFeeds', () => {
  it('parses RSS + Atom, normalizes fields, and dates to UTC YYYY-MM-DD', async () => {
    const { items, failed } = await fetchFeeds(
      fakeFetcher({ 'https://feeds.test/jsw': { body: RSS }, 'https://feeds.test/vite': { body: ATOM } }),
      sources,
    );
    expect(failed).toEqual([]);

    const vite = items.find((i) => i.title === 'v6.0.0');
    expect(vite).toMatchObject({
      source_id: 'vite',
      source_group: 'vite',
      link: 'https://github.com/vitejs/vite/releases/tag/v6.0.0',
      published_at: '2026-05-19',
    });
    expect(vite?.summary).toContain('Environment API');

    const rssItem = items.find((i) => i.title === 'Vite 6 released');
    expect(rssItem?.published_at).toBe('2026-05-20');
    expect(rssItem?.summary).toBe('Vite 6 is out with a faster bundler.');
    // item_key drops query+hash so URL noise doesn't split a story.
    expect(rssItem?.item_key).toBe('https://javascriptweekly.com/issues/700');
  });

  it('drops items with no title and gives linkless items a synthetic item_key', async () => {
    const { items } = await fetchFeeds(fakeFetcher({ 'https://feeds.test/jsw': { body: RSS }, 'https://feeds.test/vite': { body: ATOM } }), sources);
    expect(items.some((i) => i.summary === 'No title, should be dropped.')).toBe(false);
    const linkless = items.find((i) => i.title === 'A linkless blurb');
    expect(linkless?.link).toBe('');
    expect(linkless?.item_key).toBe('jsw::a linkless blurb::2026-05-21');
  });

  it('degrades a non-ok feed into `failed` without aborting the others', async () => {
    const { items, failed } = await fetchFeeds(
      fakeFetcher({ 'https://feeds.test/jsw': { status: 404 }, 'https://feeds.test/vite': { body: ATOM } }),
      sources,
    );
    expect(failed).toEqual([{ source_id: 'jsw', reason: 'HTTP 404' }]);
    expect(items.some((i) => i.title === 'v6.0.0')).toBe(true);
  });

  it('degrades a thrown fetch and malformed XML into `failed`', async () => {
    const thrown = await fetchFeeds(fakeFetcher({ 'https://feeds.test/jsw': { fail: true }, 'https://feeds.test/vite': { body: ATOM } }), sources);
    expect(thrown.failed.map((f) => f.source_id)).toContain('jsw');

    const malformed = await fetchFeeds(fakeFetcher({ 'https://feeds.test/jsw': { body: '<not xml' }, 'https://feeds.test/vite': { body: ATOM } }), sources);
    expect(malformed.failed.map((f) => f.source_id)).toContain('jsw');
    expect(malformed.items.some((i) => i.title === 'v6.0.0')).toBe(true);
  });
});

describe('toUtcDate', () => {
  it('parses common feed timestamps to a UTC date, null otherwise', () => {
    expect(toUtcDate('2026-05-19T12:00:00Z')).toBe('2026-05-19');
    expect(toUtcDate('Tue, 20 May 2026 10:00:00 GMT')).toBe('2026-05-20');
    expect(toUtcDate('2026-05-19T23:30:00-05:00')).toBe('2026-05-20'); // crosses to next UTC day
    expect(toUtcDate(undefined)).toBeNull();
    expect(toUtcDate('not a date')).toBeNull();
  });
});

describe('stableItemKey', () => {
  it('canonicalizes the link: lowercases host, drops hash + tracking params, keeps real query params sorted', () => {
    // utm_* + hash dropped, no real params left.
    expect(stableItemKey('s', 'https://Example.com/a/b/?utm_source=rss#frag', 'T', '2026-01-01')).toBe('https://example.com/a/b');
    // a permalink id in the query is preserved (would otherwise merge distinct stories); kept params sorted.
    expect(stableItemKey('s', 'https://example.com/post?id=5&utm_medium=email&b=2', 'T', null)).toBe('https://example.com/post?b=2&id=5');
  });
  it('falls back to source+title+date when there is no link', () => {
    expect(stableItemKey('jsw', '', 'Hello  World', '2026-01-01')).toBe('jsw::hello world::2026-01-01');
    expect(stableItemKey('jsw', '', 'Hello', null)).toBe('jsw::hello::nodate');
  });
});

describe('FEED_SOURCES registry', () => {
  it('has unique ids and well-formed entries', () => {
    const ids = FEED_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of FEED_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.group).not.toBe('');
    }
  });
});
