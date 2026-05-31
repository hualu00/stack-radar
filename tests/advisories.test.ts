import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdvisoriesClient } from '../src/update/advisories.js';
import { Cache } from '../src/utils/cache.js';
import type { FetchResult, Fetcher } from '../src/utils/http.js';

const json = (status: number, body: unknown): FetchResult => ({
  ok: status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

// Fake OSV: lodash@4.17.20 is vulnerable; everything else is clean.
function makeFetcher(counter: { batch: number; vuln: number }): Fetcher {
  return async (url, init) => {
    if (url.endsWith('/v1/querybatch')) {
      counter.batch++;
      const body = JSON.parse(init?.body ?? '{}') as { queries: Array<{ package: { name: string } }> };
      const results = body.queries.map((q) =>
        q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-test-lodash' }] } : {},
      );
      return json(200, { results });
    }
    if (url.includes('/v1/vulns/')) {
      counter.vuln++;
      return json(200, {
        id: 'GHSA-test-lodash',
        summary: 'Prototype pollution in lodash',
        database_specific: { severity: 'HIGH' },
        references: [{ type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-test-lodash' }],
        affected: [
          { package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] },
        ],
      });
    }
    return json(404, {});
  };
}

describe('AdvisoriesClient (OSV)', () => {
  it('reports advisories for affected versions and none for clean ones', async () => {
    const counter = { batch: 0, vuln: 0 };
    const client = createAdvisoriesClient({ fetcher: makeFetcher(counter) });
    const map = await client.query([
      { name: 'lodash', version: '4.17.20' },
      { name: 'react', version: '18.3.1' },
    ]);
    expect(map.get('lodash@4.17.20')).toEqual([
      {
        id: 'GHSA-test-lodash',
        source: 'osv',
        severity: 'HIGH',
        summary: 'Prototype pollution in lodash',
        url: 'https://github.com/advisories/GHSA-test-lodash',
        affected_range: '>=0 <4.17.21',
      },
    ]);
    expect(map.get('react@18.3.1')).toEqual([]);
    expect(counter.batch).toBe(1); // one batch covers both queries
    expect(counter.vuln).toBe(1); // one detail fetch for the single distinct vuln
  });

  it('caches results so a second run makes no requests', async () => {
    const cache = new Cache(mkdtempSync(join(tmpdir(), 'sr-osv-')));
    const counter = { batch: 0, vuln: 0 };
    const queries = [{ name: 'lodash', version: '4.17.20' }];
    await createAdvisoriesClient({ fetcher: makeFetcher(counter), cache }).query(queries);
    await createAdvisoriesClient({ fetcher: makeFetcher(counter), cache }).query(queries);
    expect(counter.batch).toBe(1);
    expect(counter.vuln).toBe(1);
  });

  it('throws on a batch failure (security outage must not look clean)', async () => {
    const fetcher: Fetcher = async (url) =>
      url.endsWith('/v1/querybatch') ? json(503, {}) : json(404, {});
    const client = createAdvisoriesClient({ fetcher });
    await expect(client.query([{ name: 'lodash', version: '4.17.20' }])).rejects.toThrow();
  });
});
