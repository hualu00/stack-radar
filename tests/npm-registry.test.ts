import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyUpdate, createNpmRegistryClient, parseRepository } from '../src/update/npm-registry.js';
import { Cache } from '../src/utils/cache.js';
import type { FetchResult, Fetcher } from '../src/utils/http.js';

const jsonResult = (status: number, body: unknown): FetchResult => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

describe('classifyUpdate', () => {
  it('classifies semver bumps', () => {
    expect(classifyUpdate('1.2.3', '2.0.0')).toBe('major');
    expect(classifyUpdate('1.2.3', '1.3.0')).toBe('minor');
    expect(classifyUpdate('1.2.3', '1.2.4')).toBe('patch');
    expect(classifyUpdate('1.2.3', '1.2.3')).toBe('none');
    expect(classifyUpdate('2.0.0', '1.0.0')).toBe('none'); // not an upgrade
    expect(classifyUpdate('1.2.3', '2.0.0-beta.1')).toBe('prerelease');
  });
  it('collapses prerelease endpoints to prerelease', () => {
    expect(classifyUpdate('1.0.0-beta.1', '1.0.0')).toBe('prerelease'); // stabilization
    expect(classifyUpdate('2.0.0-beta.1', '2.0.0-beta.2')).toBe('prerelease');
    expect(classifyUpdate('1.2.3-rc.1', '1.2.3')).toBe('prerelease');
  });
  it('is unknown when a version is missing or invalid', () => {
    expect(classifyUpdate(null, '1.0.0')).toBe('unknown');
    expect(classifyUpdate('1.0.0', 'not-semver')).toBe('unknown');
  });
});

describe('parseRepository', () => {
  it('parses common github forms', () => {
    expect(parseRepository('github:facebook/react')).toMatchObject({ owner: 'facebook', repo: 'react' });
    expect(parseRepository('git+https://github.com/facebook/react.git')).toMatchObject({ owner: 'facebook', repo: 'react' });
    expect(parseRepository({ type: 'git', url: 'https://github.com/TanStack/query.git' })).toMatchObject({ owner: 'TanStack', repo: 'query' });
    expect(parseRepository('ssh://git@github.com/vuejs/core.git')).toMatchObject({ owner: 'vuejs', repo: 'core' });
    expect(parseRepository('git@github.com:nodejs/node.git')).toMatchObject({ owner: 'nodejs', repo: 'node' });
  });
  it('carries directory for monorepo packages', () => {
    expect(
      parseRepository({ url: 'https://github.com/TanStack/query.git', directory: 'packages/react-query' }),
    ).toMatchObject({ owner: 'TanStack', repo: 'query', directory: 'packages/react-query' });
  });
  it('returns null for non-github or missing repository', () => {
    expect(parseRepository('https://gitlab.com/foo/bar')).toBeNull();
    expect(parseRepository(undefined)).toBeNull();
  });
});

describe('NpmRegistryClient', () => {
  it('fetches a packument and maps 404 to null', async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      calls++;
      if (url.includes('missing-pkg')) return jsonResult(404, {});
      return jsonResult(200, { name: 'react', 'dist-tags': { latest: '18.3.1' } });
    };
    const client = createNpmRegistryClient({ fetcher });
    expect((await client.getPackument('react'))?.['dist-tags']?.latest).toBe('18.3.1');
    expect(await client.getPackument('missing-pkg')).toBeNull();
    expect(calls).toBe(2);
  });

  it('encodes scoped names with %2F', async () => {
    let seen = '';
    const fetcher: Fetcher = async (url) => {
      seen = url;
      return jsonResult(200, { name: '@scope/pkg' });
    };
    await createNpmRegistryClient({ fetcher }).getPackument('@scope/pkg');
    expect(seen).toBe('https://registry.npmjs.org/@scope%2Fpkg');
  });

  it('serves a cache hit without touching the network', async () => {
    const cache = new Cache(mkdtempSync(join(tmpdir(), 'sr-cache-')));
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls++;
      return jsonResult(200, { name: 'x', 'dist-tags': { latest: '1.0.0' } });
    };
    const client = createNpmRegistryClient({ fetcher, cache });
    await client.getPackument('x'); // miss -> fetch + write
    await client.getPackument('x'); // hit -> no fetch
    expect(calls).toBe(1);
  });

  it('refresh bypasses the cache read but still writes', async () => {
    const cache = new Cache(mkdtempSync(join(tmpdir(), 'sr-cache-')));
    let latest = '1.0.0';
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls++;
      return jsonResult(200, { name: 'x', 'dist-tags': { latest } });
    };
    await createNpmRegistryClient({ fetcher, cache }).getPackument('x'); // warm cache @1.0.0
    latest = '2.0.0';
    const fresh = await createNpmRegistryClient({ fetcher, cache, refresh: true }).getPackument('x');
    expect(calls).toBe(2); // refresh re-fetched despite cache
    expect(fresh?.['dist-tags']?.latest).toBe('2.0.0');
    // and the new value was written back
    expect((await createNpmRegistryClient({ fetcher, cache }).getPackument('x'))?.['dist-tags']?.latest).toBe('2.0.0');
    expect(calls).toBe(2); // last call served from refreshed cache
  });
});
