import { join } from 'node:path';
import { type TrendMention, type TrendsFile, emptyTrendsFile } from '../types/trend.js';
import { fileExists, readText, writeJsonAtomic } from '../utils/fs.js';

/** Thrown when trends.json exists but is unreadable or structurally invalid. */
export class TrendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrendError';
  }
}

/**
 * Persistence for the trend time-series. PERSISTENCE ONLY — all product policy
 * (canonicalization, relations, signal/spike classification) lives in
 * relations.ts / aggregate.ts. `item_key` is treated as already-canonical and
 * immutable: it is never recomputed here, so older rows can't shift if the
 * canonicalization rules change later.
 */
export interface TrendStore {
  /**
   * Insert mentions, skipping any whose (tool_key, source_id, item_key) already
   * exists — the existing row (and its `observed_at`) is preserved, so reruns
   * never change week buckets. Persists atomically. Returns the count added.
   */
  recordMentions(mentions: readonly TrendMention[]): number;
  /** All stored mentions in a stable order (a copy; callers can't mutate state). */
  mentions(): TrendMention[];
}

/** Dedup identity: one row per tool, per feed, per story (codex: preserve provenance). */
function mentionKey(m: Pick<TrendMention, 'tool_key' | 'source_id' | 'item_key'>): string {
  return `${m.tool_key}@@${m.source_id}@@${m.item_key}`;
}

function sortMentions(mentions: TrendMention[]): TrendMention[] {
  return [...mentions].sort(
    (a, b) =>
      a.tool_key.localeCompare(b.tool_key) ||
      a.source_id.localeCompare(b.source_id) ||
      a.item_key.localeCompare(b.item_key) ||
      (a.published_at ?? '').localeCompare(b.published_at ?? '') ||
      a.observed_at.localeCompare(b.observed_at),
  );
}

class JsonTrendStore implements TrendStore {
  private readonly seen: Set<string>;
  constructor(
    private readonly path: string,
    private readonly file: TrendsFile,
  ) {
    this.seen = new Set(file.mentions.map(mentionKey));
  }

  recordMentions(incoming: readonly TrendMention[]): number {
    let added = 0;
    for (const m of incoming) {
      const key = mentionKey(m);
      if (this.seen.has(key)) continue; // preserve the existing row + observed_at
      this.seen.add(key);
      this.file.mentions.push({ ...m }); // copy: don't retain the caller's reference
      added += 1;
    }
    if (added > 0) {
      this.file.mentions = sortMentions(this.file.mentions);
      writeJsonAtomic(this.path, { version: 1, mentions: this.file.mentions });
    }
    return added;
  }

  mentions(): TrendMention[] {
    return sortMentions(this.file.mentions).map((m) => ({ ...m })); // copies: callers can't mutate state
  }
}

/**
 * Open the trend store at `.stack-radar/trends.json`. Missing file → empty store;
 * present-but-unreadable or malformed → throws `TrendError` (never silently
 * discards accumulated history).
 */
export function loadTrendStore(repoPath: string): TrendStore {
  const path = join(repoPath, '.stack-radar', 'trends.json');
  if (!fileExists(path)) return new JsonTrendStore(path, emptyTrendsFile());
  const text = readText(path);
  if (text === null) throw new TrendError(`trends.json exists but could not be read: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TrendError(`trends.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new JsonTrendStore(path, parseTrendsFile(raw));
}

/** Validate + coerce the on-disk shape. Strict on types; throws `TrendError`. */
export function parseTrendsFile(raw: unknown): TrendsFile {
  if (!isObject(raw)) throw new TrendError('trends.json must be an object');
  if (raw.version !== 1) throw new TrendError(`trends.json version must be 1 (got ${JSON.stringify(raw.version)})`);
  if (!Array.isArray(raw.mentions)) throw new TrendError('trends.json `mentions` must be an array');
  return { version: 1, mentions: raw.mentions.map((m, i) => parseMention(m, i)) };
}

function parseMention(raw: unknown, i: number): TrendMention {
  if (!isObject(raw)) throw new TrendError(`mentions[${i}] must be an object`);
  const nonEmpty = (key: string): string => {
    const v = raw[key];
    if (typeof v !== 'string' || v === '') throw new TrendError(`mentions[${i}].${key} must be a non-empty string`);
    return v;
  };
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== 'string') throw new TrendError(`mentions[${i}].${key} must be a string`);
    return v;
  };
  // Required, non-empty (validated first, so a missing tool_key reads as such).
  const tool_key = nonEmpty('tool_key');
  const display_name = nonEmpty('display_name');
  const source_id = nonEmpty('source_id');
  const source_group = nonEmpty('source_group');
  const item_key = nonEmpty('item_key');
  // Required strings, but may be empty (a linkless item has item_url '').
  const item_url = str('item_url');
  const title = str('title');

  const observed_at = nonEmpty('observed_at');
  if (!isIsoDate(observed_at)) throw new TrendError(`mentions[${i}].observed_at must be a YYYY-MM-DD date`);

  const published_at = raw.published_at === undefined ? null : raw.published_at;
  if (published_at !== null && (typeof published_at !== 'string' || !isIsoDate(published_at))) {
    throw new TrendError(`mentions[${i}].published_at must be a YYYY-MM-DD date or null`);
  }

  return { tool_key, display_name, source_id, source_group, item_key, item_url, title, published_at, observed_at };
}

/** Strict YYYY-MM-DD calendar date (so bad rows can't produce NaN week keys downstream). */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, mo, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
