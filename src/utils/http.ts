/**
 * Minimal injectable HTTP layer. The default fetcher wraps global `fetch` with
 * a timeout and limited retry on network errors / 5xx. Tests inject a fake
 * `Fetcher` so the suite never touches the real network.
 */

export interface FetchResult {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResult>;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a Retry-After header (delta-seconds), capped at 10s; ignores HTTP-date form. */
function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds, 10) * 1000;
}

/** Real fetcher: AbortController timeout + retry on network error / 5xx. */
export const defaultFetcher: Fetcher = async (url, init = {}) => {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: controller.signal });
      clearTimeout(timer);
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_ATTEMPTS) {
        const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : 0;
        await delay(retryAfter || 250 * attempt);
        continue;
      }
      return {
        ok: res.ok,
        status: res.status,
        text: () => res.text(),
        json: () => res.json(),
      };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await delay(250 * attempt);
    }
  }
  throw new HttpError(`request failed after ${MAX_ATTEMPTS} attempts: ${url}`, url, { cause: lastError });
};
