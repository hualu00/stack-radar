import { Octokit } from 'octokit';
import type { Cache } from '../utils/cache.js';

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

export interface GitHubClient {
  /** All (non-draft handled by caller) releases for a repo, paginated + cached. */
  listReleases(owner: string, repo: string): Promise<GitHubRelease[]>;
}

/** Minimal slice of octokit we depend on, so it can be swapped/typed loosely. */
interface OctokitLike {
  paginate: (
    route: unknown,
    params: Record<string, unknown>,
    mapFn?: (response: { data: unknown[] }, done: () => void) => unknown[],
  ) => Promise<unknown[]>;
  rest: { repos: { listReleases: unknown } };
}

export interface GitHubClientOptions {
  token?: string;
  cache?: Cache;
  refresh?: boolean;
  /** Inject a pre-built octokit (tests / custom auth); defaults to a lazy real one. */
  octokit?: OctokitLike;
}

/** Cap pagination: releases come newest-first, so the recent pages cover the
 * (locked, latest] range for realistic upgrades without walking huge histories. */
const MAX_PAGES = 3;

/** True only for genuine rate-limit errors — a generic 403 (e.g. no permission
 * to a private repo) must fail just that repo, not trip the run-wide breaker. */
function isRateLimit(error: unknown): boolean {
  const e = error as { status?: number; message?: string; response?: { headers?: Record<string, string> } } | null;
  if (!e) return false;
  if (e.status === 429) return true;
  if (e.status === 403 && e.response?.headers?.['x-ratelimit-remaining'] === '0') return true;
  return /rate limit|secondary rate/i.test(e.message ?? '');
}

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const { cache, refresh = false, token } = options;
  let octokit = options.octokit;
  let rateLimited = false;

  const getOctokit = (): OctokitLike =>
    (octokit ??= new Octokit({
      auth: token,
      // Fail fast on rate limits instead of waiting for the hourly quota to reset.
      throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false },
      retry: { enabled: false },
      // Silence octokit's internal logging (e.g. "quota exhausted" warnings) — we
      // report outcomes ourselves via record status/notes.
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as unknown as OctokitLike);

  return {
    async listReleases(owner, repo) {
      const key = `${owner}__${repo}`;
      if (cache && !refresh) {
        const hit = cache.readJson<GitHubRelease[]>('github', key);
        if (hit) return hit;
      }
      // Circuit breaker: once rate-limited, stop hitting GitHub for the rest of
      // the run. Callers catch this and degrade to CHANGELOG / lower confidence.
      if (rateLimited) throw new Error('github rate limit reached; skipping releases');

      const client = getOctokit();
      let page = 0;
      let raw: unknown[];
      try {
        raw = await client.paginate(client.rest.repos.listReleases, { owner, repo, per_page: 100 }, (response, done) => {
          if (++page >= MAX_PAGES) done();
          return response.data;
        });
      } catch (error) {
        if (isRateLimit(error)) rateLimited = true;
        throw error;
      }

      const releases: GitHubRelease[] = raw.map((r) => {
        const rel = r as Partial<GitHubRelease>;
        return {
          tag_name: rel.tag_name ?? '',
          name: rel.name ?? null,
          body: rel.body ?? null,
          html_url: rel.html_url ?? '',
          prerelease: Boolean(rel.prerelease),
          draft: Boolean(rel.draft),
        };
      });
      cache?.writeJson('github', key, releases);
      return releases;
    },
  };
}
