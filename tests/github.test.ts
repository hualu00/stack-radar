import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../src/update/github.js';
import { Cache } from '../src/utils/cache.js';

function fakeOctokit(releases: unknown[], counter: { calls: number }) {
  return {
    rest: { repos: { listReleases: 'LIST_RELEASES' } },
    paginate: async () => {
      counter.calls++;
      return releases;
    },
  };
}

const raw = [
  { tag_name: 'v1.0.0', name: 'v1.0.0', body: 'first', html_url: 'https://github.com/o/r/releases/tag/v1.0.0', prerelease: false, draft: false },
  // missing name/body -> normalized to null
  { tag_name: 'v1.1.0', html_url: 'https://github.com/o/r/releases/tag/v1.1.0', prerelease: false, draft: false },
];

describe('createGitHubClient', () => {
  it('paginates and normalizes releases', async () => {
    const counter = { calls: 0 };
    const client = createGitHubClient({ octokit: fakeOctokit(raw, counter) });
    const releases = await client.listReleases('o', 'r');
    expect(counter.calls).toBe(1);
    expect(releases).toHaveLength(2);
    expect(releases[1]).toMatchObject({ tag_name: 'v1.1.0', name: null, body: null });
  });

  it('serves cache hits and re-fetches on refresh', async () => {
    const cache = new Cache(mkdtempSync(join(tmpdir(), 'sr-gh-')));
    const counter = { calls: 0 };
    await createGitHubClient({ octokit: fakeOctokit(raw, counter), cache }).listReleases('o', 'r'); // miss
    await createGitHubClient({ octokit: fakeOctokit(raw, counter), cache }).listReleases('o', 'r'); // hit
    expect(counter.calls).toBe(1);
    await createGitHubClient({ octokit: fakeOctokit(raw, counter), cache, refresh: true }).listReleases('o', 'r');
    expect(counter.calls).toBe(2);
  });

  it('trips the circuit breaker on a rate-limit 403 (stops hitting GitHub)', async () => {
    const rateError = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    let calls = 0;
    const octokit = {
      rest: { repos: { listReleases: 'L' } },
      async paginate() {
        calls++;
        throw rateError;
      },
    };
    const client = createGitHubClient({ octokit });
    await expect(client.listReleases('o', 'r1')).rejects.toThrow();
    await expect(client.listReleases('o', 'r2')).rejects.toThrow(/rate limit reached/);
    expect(calls).toBe(1); // second call short-circuited, no network
  });

  it('does NOT trip the breaker on a generic 403 (only that repo fails)', async () => {
    const permError = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    let calls = 0;
    const octokit = {
      rest: { repos: { listReleases: 'L' } },
      async paginate() {
        calls++;
        throw permError;
      },
    };
    const client = createGitHubClient({ octokit });
    await expect(client.listReleases('o', 'r1')).rejects.toThrow();
    await expect(client.listReleases('o', 'r2')).rejects.toThrow();
    expect(calls).toBe(2); // both attempted — breaker not tripped
  });

  it('caps pagination at 3 pages', async () => {
    const counter = { pages: 0 };
    const octokit = {
      rest: { repos: { listReleases: 'L' } },
      async paginate(_route: unknown, _params: unknown, mapFn?: (r: { data: unknown[] }, done: () => void) => unknown[]) {
        const all: unknown[] = [];
        for (let p = 1; p <= 10; p++) {
          let stop = false;
          const data = [{ tag_name: `v${p}.0.0`, html_url: '', prerelease: false, draft: false }];
          all.push(...(mapFn ? mapFn({ data }, () => { stop = true; }) : data));
          counter.pages = p;
          if (stop) break;
        }
        return all;
      },
    };
    const releases = await createGitHubClient({ octokit }).listReleases('o', 'r');
    expect(counter.pages).toBe(3);
    expect(releases).toHaveLength(3);
  });
});
