import type { Advisory } from '../types/update.js';
import type { Cache } from '../utils/cache.js';
import { type Fetcher, defaultFetcher } from '../utils/http.js';

export interface AdvisoryQuery {
  /** Real (public) package name. */
  name: string;
  version: string;
}

export interface AdvisoriesClient {
  /** Returns advisories per `${name}@${version}` key for the given queries. */
  query(queries: AdvisoryQuery[]): Promise<Map<string, Advisory[]>>;
}

export interface AdvisoriesClientOptions {
  fetcher?: Fetcher;
  cache?: Cache;
  refresh?: boolean;
}

const OSV = 'https://api.osv.dev';

const key = (q: AdvisoryQuery): string => `${q.name}@${q.version}`;

/**
 * OSV-backed advisories. Uses POST /v1/querybatch to find affected versions in
 * one request, then GET /v1/vulns/{id} for details (both cached). OSV already
 * aggregates GitHub's GHSA database, so it covers GitHub advisories too.
 */
export function createAdvisoriesClient(options: AdvisoriesClientOptions = {}): AdvisoriesClient {
  const fetcher = options.fetcher ?? defaultFetcher;
  const { cache, refresh = false } = options;

  async function getVulnDetail(id: string): Promise<OsvVuln | null> {
    if (cache && !refresh) {
      const hit = cache.readJson<OsvVuln>('osv_vuln', id);
      if (hit) return hit;
    }
    const res = await fetcher(`${OSV}/v1/vulns/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const vuln = (await res.json()) as OsvVuln;
    cache?.writeJson('osv_vuln', id, vuln);
    return vuln;
  }

  return {
    async query(queries) {
      const result = new Map<string, Advisory[]>();
      const misses: AdvisoryQuery[] = [];

      for (const q of queries) {
        if (cache && !refresh) {
          const hit = cache.readJson<Advisory[]>('osv', key(q));
          if (hit) {
            result.set(key(q), hit);
            continue;
          }
        }
        misses.push(q);
      }
      if (misses.length === 0) return result;

      // Phase 1: batch query for vuln ids per (name, version). Failures throw —
      // a security-data outage must NOT be mistaken for "no advisories" (codex).
      const body = JSON.stringify({
        queries: misses.map((q) => ({ package: { ecosystem: 'npm', name: q.name }, version: q.version })),
      });
      const res = await fetcher(`${OSV}/v1/querybatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
      });
      if (!res.ok) throw new Error(`OSV querybatch returned ${res.status}`);
      const batch = (await res.json()) as OsvBatchResponse;
      const results = batch.results ?? [];
      if (results.length !== misses.length) {
        throw new Error('OSV querybatch returned misaligned results');
      }

      // Phase 2: resolve details for each distinct vuln id.
      const ids = new Set<string>();
      for (const r of results) for (const v of r.vulns ?? []) ids.add(v.id);
      const details = new Map<string, OsvVuln>();
      for (const id of ids) {
        const detail = await getVulnDetail(id);
        if (detail) details.set(id, detail);
      }

      misses.forEach((q, i) => {
        const r = results[i];
        const advisories = (r?.vulns ?? []).map((v) => toAdvisory(v.id, details.get(v.id), q.name));
        // Don't cache a paginated (incomplete) result — re-query next run.
        if (!r?.next_page_token) cache?.writeJson('osv', key(q), advisories);
        result.set(key(q), advisories);
      });
      return result;
    },
  };
}

/** Build an Advisory, selecting the affected entry matching the queried package. */
function toAdvisory(id: string, vuln: OsvVuln | undefined, name: string): Advisory {
  const affected = vuln?.affected?.find((a) => a.package?.ecosystem === 'npm' && a.package?.name === name);
  return {
    id,
    source: 'osv',
    severity: extractSeverity(vuln, affected),
    summary: vuln?.summary ?? vuln?.details?.slice(0, 200),
    url: vuln?.references?.find((r) => r.type === 'ADVISORY')?.url ?? `https://osv.dev/vulnerability/${id}`,
    affected_range: extractRange(affected),
  };
}

function extractSeverity(vuln: OsvVuln | undefined, affected: OsvAffected | undefined): string | undefined {
  return (
    vuln?.database_specific?.severity ??
    affected?.ecosystem_specific?.severity ??
    affected?.database_specific?.severity ??
    vuln?.severity?.[0]?.score
  );
}

function extractRange(affected: OsvAffected | undefined): string | undefined {
  const events = affected?.ranges?.[0]?.events;
  if (!events) return undefined;
  const introduced = events.find((e) => e.introduced)?.introduced;
  const fixed = events.find((e) => e.fixed)?.fixed;
  if (introduced && fixed) return `>=${introduced} <${fixed}`;
  if (fixed) return `<${fixed}`;
  if (introduced) return `>=${introduced}`;
  return undefined;
}

// --- Minimal OSV response shapes (only what we read) ---
interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id: string; modified?: string }>; next_page_token?: string }>;
}
interface OsvAffected {
  package?: { ecosystem?: string; name?: string };
  ranges?: Array<{ events?: Array<{ introduced?: string; fixed?: string }> }>;
  ecosystem_specific?: { severity?: string };
  database_specific?: { severity?: string };
}
interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type?: string; score?: string }>;
  references?: Array<{ type?: string; url?: string }>;
  database_specific?: { severity?: string };
  affected?: OsvAffected[];
}
