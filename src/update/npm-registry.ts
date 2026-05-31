import semver from 'semver';
import type { UpdateType } from '../types/update.js';
import type { Cache } from '../utils/cache.js';
import { type Fetcher, defaultFetcher } from '../utils/http.js';

/** A single published version's relevant metadata. */
export interface PackumentVersion {
  version: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  deprecated?: string | boolean;
  gitHead?: string;
  repository?: unknown;
}

/** The npm registry "packument" (full package document), trimmed to what we use. */
export interface Packument {
  name: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
  time?: Record<string, string>;
  repository?: unknown;
}

export interface RepoRef {
  host: 'github';
  owner: string;
  repo: string;
  /** Sub-directory for monorepo packages (npm `repository.directory`). */
  directory?: string;
}

export interface NpmRegistryClient {
  /** Returns the packument, or null on 404 (package not public). */
  getPackument(name: string): Promise<Packument | null>;
}

export interface NpmRegistryClientOptions {
  fetcher?: Fetcher;
  cache?: Cache;
  refresh?: boolean;
}

const REGISTRY = 'https://registry.npmjs.org';

export function createNpmRegistryClient(options: NpmRegistryClientOptions = {}): NpmRegistryClient {
  const fetcher = options.fetcher ?? defaultFetcher;
  const { cache, refresh = false } = options;

  return {
    async getPackument(name) {
      if (cache && !refresh) {
        const hit = cache.readJson<Packument>('npm', name);
        if (hit) return hit;
      }
      // Encode only the scope slash; the registry expects "@scope%2Fpkg".
      const url = `${REGISTRY}/${name.replace(/\//g, '%2F')}`;
      const res = await fetcher(url, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`npm registry returned ${res.status} for ${name}`);
      const packument = (await res.json()) as Packument;
      cache?.writeJson('npm', name, packument);
      return packument;
    },
  };
}

export function latestVersion(packument: Packument): string | null {
  return packument['dist-tags']?.latest ?? null;
}

export function versionMeta(packument: Packument, version: string): PackumentVersion | undefined {
  return packument.versions?.[version];
}

/**
 * Parse an npm `repository` field (string or object) into an owner/repo ref.
 * Only GitHub is supported in M2; other hosts return null.
 */
export function parseRepository(repository: unknown, directory?: string): RepoRef | null {
  let url: string | undefined;
  let dir = directory;

  if (typeof repository === 'string') {
    url = repository;
  } else if (repository && typeof repository === 'object') {
    const obj = repository as { url?: unknown; directory?: unknown };
    if (typeof obj.url === 'string') url = obj.url;
    if (dir === undefined && typeof obj.directory === 'string') dir = obj.directory;
  }
  if (!url) return null;
  url = url.trim();

  // Shorthand: "github:owner/repo"
  const shorthand = /^github:([^/]+)\/(.+)$/i.exec(url);
  if (shorthand?.[1] && shorthand[2]) {
    return { host: 'github', owner: shorthand[1], repo: stripGitSuffix(shorthand[2]), directory: dir };
  }

  // Any github.com URL: git+https, https, ssh://git@, git://, scp-like git@github.com:, www.
  const match = /github\.com[:/]([^/]+)\/([^/#?]+)/i.exec(url);
  if (match?.[1] && match[2]) {
    return { host: 'github', owner: match[1], repo: stripGitSuffix(match[2]), directory: dir };
  }
  return null;
}

function stripGitSuffix(repo: string): string {
  // Strip a #fragment / ?query first, then a trailing .git (order matters for
  // forms like "github:o/r.git#sha").
  return repo.replace(/[#?].*$/, '').replace(/\.git$/, '');
}

/**
 * Semver bump from locked → latest. Not an upgrade → 'none'; any prerelease on
 * either endpoint collapses to 'prerelease'; missing/invalid → 'unknown'.
 */
export function classifyUpdate(locked: string | null, latest: string | null): UpdateType {
  if (!locked || !latest || !semver.valid(locked) || !semver.valid(latest)) return 'unknown';
  if (semver.eq(locked, latest) || semver.lt(latest, locked)) return 'none';
  if (semver.prerelease(locked) || semver.prerelease(latest)) return 'prerelease';
  const diff = semver.diff(locked, latest);
  if (!diff) return 'none';
  if (diff.startsWith('pre')) return 'prerelease';
  return diff as 'major' | 'minor' | 'patch';
}
