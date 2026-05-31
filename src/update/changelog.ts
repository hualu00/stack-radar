import semver from 'semver';
import type { ReleaseNote } from '../types/update.js';
import type { Cache } from '../utils/cache.js';
import { type Fetcher, defaultFetcher } from '../utils/http.js';
import type { GitHubClient, GitHubRelease } from './github.js';
import type { RepoRef } from './npm-registry.js';

/** Release note ref + its raw body text (kept transient, for signal scanning). */
export interface VersionText {
  version: string;
  text: string;
}
export interface ReleaseNotesResult {
  notes: ReleaseNote[];
  texts: VersionText[];
}

export interface ChangelogSources {
  github: GitHubClient;
  fetcher?: Fetcher;
  cache?: Cache;
  refresh?: boolean;
}

export interface ChangelogQuery {
  repo: RepoRef | null;
  /** Real package name (for monorepo tag matching). */
  name: string;
  locked: string | null;
  latest: string | null;
}

/**
 * Cap persisted release-note text. The full body is still used for signal
 * detection; only the copy stored in updates.json (and later sent to the AI) is
 * truncated, for size and token control. Bump if the policy changes materially.
 */
export const MAX_NOTE_TEXT_CHARS = 4000;

function truncateNoteText(body: string): { text?: string; text_truncated?: boolean } {
  const trimmed = body.trim();
  if (trimmed === '') return {}; // no body → omit text entirely
  if (trimmed.length <= MAX_NOTE_TEXT_CHARS) return { text: trimmed };
  return { text: trimmed.slice(0, MAX_NOTE_TEXT_CHARS), text_truncated: true };
}

/** Parse a release tag into an optional package prefix + semver version. */
export function parseTag(tag: string): { prefix: string; version: string | null } {
  const at = tag.lastIndexOf('@');
  let prefix = '';
  let rest = tag;
  if (at > 0) {
    prefix = tag.slice(0, at);
    rest = tag.slice(at + 1);
  }
  const candidate = rest.replace(/^v/i, '');
  const version = semver.valid(candidate) ?? semver.coerce(candidate)?.version ?? null;
  return { prefix, version };
}

function unscoped(name: string): string {
  const i = name.indexOf('/');
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Releases strictly newer than `locked` and not beyond `latest`, monorepo-filtered. */
function selectReleases(
  releases: GitHubRelease[],
  name: string,
  locked: string,
  latest: string,
  hasDirectory: boolean,
): GitHubRelease[] {
  // Only treat as a monorepo when the repository declares a directory, or some
  // tag is actually prefixed with this package's name — otherwise a single
  // foreign `pkg@x` tag would wrongly drop all plain `v1.2.3` releases (codex).
  const prefixMatches = releases.some((r) => {
    const { prefix } = parseTag(r.tag_name);
    return prefix === name || prefix === unscoped(name);
  });
  const monorepoMode = hasDirectory || prefixMatches;

  return releases.filter((r) => {
    if (r.draft) return false;
    const { prefix, version } = parseTag(r.tag_name);
    if (monorepoMode && prefix !== name && prefix !== unscoped(name)) return false;
    if (!version) return false;
    if (!semver.gt(version, locked)) return false;
    if (semver.gt(version, latest)) return false;
    return true;
  });
}

/**
 * Changelog fallback chain (PLAN §5): GitHub Releases (high) → repo CHANGELOG.md
 * (medium) → none. Degrades rather than fabricating: an empty release selection
 * falls through to CHANGELOG.md instead of claiming a github_release.
 */
export async function collectReleaseNotes(
  query: ChangelogQuery,
  sources: ChangelogSources,
): Promise<ReleaseNotesResult> {
  const { repo, name, locked, latest } = query;
  if (!repo) return { notes: [], texts: [] };

  // Release-range selection only makes sense with both bounds valid; otherwise
  // fall straight through to CHANGELOG.md (codex — avoids selecting everything).
  let selected: GitHubRelease[] = [];
  if (locked && latest && semver.valid(locked) && semver.valid(latest)) {
    let releases: GitHubRelease[] = [];
    try {
      releases = await sources.github.listReleases(repo.owner, repo.repo);
    } catch {
      releases = [];
    }
    selected = selectReleases(releases, name, locked, latest, Boolean(repo.directory)).sort(compareDesc);
  }

  if (selected.length > 0) {
    return {
      notes: selected.map((r) => {
        const version = parseTag(r.tag_name).version ?? r.tag_name;
        return { version, url: r.html_url, source: 'github_release', confidence: 'high', ...truncateNoteText(r.body ?? '') };
      }),
      texts: selected.map((r) => ({ version: parseTag(r.tag_name).version ?? r.tag_name, text: r.body ?? '' })),
    };
  }

  const changelog = await fetchChangelog(repo, sources);
  if (changelog) {
    const version = latest ?? 'unknown';
    return {
      notes: [{ version, url: changelog.url, source: 'changelog_md', confidence: 'medium', ...truncateNoteText(changelog.text) }],
      texts: [{ version, text: changelog.text }],
    };
  }

  return { notes: [], texts: [] };
}

function compareDesc(a: GitHubRelease, b: GitHubRelease): number {
  const va = parseTag(a.tag_name).version;
  const vb = parseTag(b.tag_name).version;
  if (va && vb) return semver.rcompare(va, vb);
  return b.tag_name.localeCompare(a.tag_name);
}

interface ChangelogHit {
  url: string;
  text: string;
}

async function fetchChangelog(repo: RepoRef, sources: ChangelogSources): Promise<ChangelogHit | null> {
  const fetcher = sources.fetcher ?? defaultFetcher;
  const cache = sources.cache;
  const cacheKey = `${repo.owner}__${repo.repo}__${repo.directory ?? ''}`;

  if (cache && !sources.refresh) {
    const hit = cache.readJson<ChangelogHit>('changelogs', cacheKey);
    if (hit) return hit.url ? hit : null; // empty url marks "known absent"
  }

  const paths = repo.directory ? [`${repo.directory}/CHANGELOG.md`, 'CHANGELOG.md'] : ['CHANGELOG.md'];
  for (const path of paths) {
    const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${path}`;
    try {
      const res = await fetcher(rawUrl, { headers: { accept: 'text/plain' } });
      if (res.ok) {
        const text = await res.text();
        const hit: ChangelogHit = { url: `https://github.com/${repo.owner}/${repo.repo}/blob/HEAD/${path}`, text };
        cache?.writeJson('changelogs', cacheKey, hit);
        return hit;
      }
    } catch {
      // try next candidate path
    }
  }
  cache?.writeJson('changelogs', cacheKey, { url: '', text: '' }); // remember absence
  return null;
}
