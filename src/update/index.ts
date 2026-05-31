import { join } from 'node:path';
import type { StackJson } from '../types/stack.js';
import {
  type Advisory,
  type Instance,
  type Requirements,
  type UpdateRecord,
  emptyRequirements,
  emptySignals,
} from '../types/update.js';
import { readPackageJson } from '../scanner/package-json.js';
import { detectMonorepo, expandWorkspaces } from '../scanner/workspace.js';
import { Cache } from '../utils/cache.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { type Fetcher, defaultFetcher } from '../utils/http.js';
import { readJson } from '../utils/fs.js';
import { type AdvisoriesClient, createAdvisoriesClient } from './advisories.js';
import { collectReleaseNotes } from './changelog.js';
import { type GitHubClient, createGitHubClient } from './github.js';
import {
  type NpmRegistryClient,
  type Packument,
  classifyUpdate,
  createNpmRegistryClient,
  latestVersion,
  parseRepository,
  versionMeta,
} from './npm-registry.js';
import { detectSignals } from './signals.js';

/** Injectable external clients (real by default; faked in tests). */
export interface CheckUpdatesClients {
  npm: NpmRegistryClient;
  github: GitHubClient;
  advisories: AdvisoriesClient;
  fetcher: Fetcher;
}

export interface CheckUpdatesOptions {
  refresh?: boolean;
  clients?: Partial<CheckUpdatesClients>;
}

interface Group {
  name: string;
  /** Real package name to query (differs from `name` for aliases). */
  realName: string;
  locked: string | null;
  instances: Instance[];
}

const GITHUB_CONCURRENCY = 5;

export async function checkUpdates(repoPath: string, options: CheckUpdatesOptions = {}): Promise<UpdateRecord[]> {
  const stack = readStack(repoPath);
  const refresh = options.refresh ?? false;
  const cache = new Cache(join(repoPath, '.stack-radar', 'cache'));
  const clients = resolveClients(cache, refresh, options.clients);

  const groups = groupByNameAndLocked(stack);

  // The only reliable zero-leak "private" signal is local workspace membership.
  // We deliberately do NOT infer privacy from a non-npmjs .npmrc registry: that is
  // usually a MIRROR of public npm, so most packages there are public. Everything
  // else is queried on the public registry; genuinely-private packages simply 404
  // and become `not_found`.
  const workspaceNames = collectWorkspaceNames(repoPath);

  const records: UpdateRecord[] = [];
  const publicGroups: Group[] = [];

  for (const group of groups) {
    if (workspaceNames.has(group.realName)) {
      records.push(baseRecord(group, 'skipped_private', 'local workspace package; not queried externally'));
    } else {
      publicGroups.push(group);
    }
  }

  // Advisories in a single batch (with all public name@version pairs).
  const advisoryQueries = publicGroups
    .filter((g) => g.locked)
    .map((g) => ({ name: g.realName, version: g.locked as string }));
  let advisoriesByKey = new Map<string, Advisory[]>();
  let advisoryUnavailable = false;
  if (advisoryQueries.length > 0) {
    try {
      advisoriesByKey = await clients.advisories.query(advisoryQueries);
    } catch {
      advisoryUnavailable = true;
    }
  }

  const enriched = await mapWithConcurrency(publicGroups, GITHUB_CONCURRENCY, (group) =>
    processGroup(group, { clients, cache, refresh, advisoriesByKey, advisoryUnavailable }),
  );
  records.push(...enriched);

  records.sort(
    (a, b) => a.name.localeCompare(b.name) || (a.locked_version ?? '').localeCompare(b.locked_version ?? ''),
  );
  return records;
}

interface ProcessContext {
  clients: CheckUpdatesClients;
  cache: Cache;
  refresh: boolean;
  advisoriesByKey: Map<string, Advisory[]>;
  advisoryUnavailable: boolean;
}

async function processGroup(group: Group, ctx: ProcessContext): Promise<UpdateRecord> {
  const record = baseRecord(group, 'ok');
  if (group.realName !== group.name) record.resolved_name = group.realName;

  try {
    const packument = await ctx.clients.npm.getPackument(group.realName);
    if (!packument) {
      return { ...record, status: 'not_found', note: 'not on the public npm registry (private/internal or unpublished)' };
    }

    const latest = latestVersion(packument);
    record.latest_version = latest;
    record.update_type = classifyUpdate(group.locked, latest);
    record.requirements = extractRequirements(packument, latest);

    // Prefer top-level repository; fall back to the version's repository only if
    // the top-level one is missing or non-parseable (codex).
    const repo =
      parseRepository(packument.repository) ?? parseRepository(versionMeta(packument, latest ?? '')?.repository);
    const { notes: releaseNotes, texts } = await collectReleaseNotes(
      { repo, name: group.realName, locked: group.locked, latest },
      { github: ctx.clients.github, fetcher: ctx.clients.fetcher, cache: ctx.cache, refresh: ctx.refresh },
    );
    record.release_notes = releaseNotes;

    const advisories = group.locked ? (ctx.advisoriesByKey.get(`${group.realName}@${group.locked}`) ?? []) : [];
    record.advisories = advisories;

    const { signals, notes: signalNotes } = detectSignals({
      packument,
      locked: group.locked,
      latest,
      advisories,
      texts,
    });
    record.signals = signals;

    const notes = [...signalNotes];
    if (ctx.advisoryUnavailable && group.locked) {
      // Security data was unavailable — don't let security:false look like "clean".
      record.status = 'partial';
      notes.unshift('advisory check unavailable (OSV); security signal may be incomplete');
    }
    if (notes.length > 0) record.note = notes.join('; ');
    return record;
  } catch (error) {
    return { ...record, status: 'error', note: error instanceof Error ? error.message : String(error) };
  }
}

function baseRecord(group: Group, status: UpdateRecord['status'], note?: string): UpdateRecord {
  const record: UpdateRecord = {
    name: group.name,
    instances: group.instances,
    locked_version: group.locked,
    latest_version: null,
    update_type: 'unknown',
    release_notes: [],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status,
  };
  if (group.realName !== group.name) record.resolved_name = group.realName;
  if (note) record.note = note;
  return record;
}

/** Latest version's node/peer requirements, for Blocked scoring (sorted keys, string-validated). */
function extractRequirements(packument: Packument, latest: string | null): Requirements {
  const meta = latest ? versionMeta(packument, latest) : undefined;
  const peersRaw = meta?.peerDependencies ?? {};
  const peers: Record<string, string> = {};
  for (const name of Object.keys(peersRaw).sort()) {
    const range = peersRaw[name];
    if (typeof range === 'string') peers[name] = range; // ignore malformed registry values
  }
  const optional_peers = Object.entries(meta?.peerDependenciesMeta ?? {})
    .filter(([, m]) => m?.optional)
    .map(([name]) => name)
    .sort();
  const node = typeof meta?.engines?.node === 'string' ? meta.engines.node : null;
  return { node, peers, optional_peers };
}

function groupByNameAndLocked(stack: StackJson): Group[] {
  const map = new Map<string, Group>();
  for (const item of stack.items) {
    const realName = aliasTarget(item.current_range) ?? item.name;
    // Key includes realName so two declared names aliasing to different targets
    // (same locked version) don't collapse together (codex).
    const key = `${item.name}@@${realName}@@${item.locked_version ?? ''}`;
    const instance: Instance = {
      workspace: item.workspace,
      current_range: item.current_range,
      dependency_type: item.dependency_type,
    };
    const existing = map.get(key);
    if (existing) {
      existing.instances.push(instance);
    } else {
      map.set(key, { name: item.name, realName, locked: item.locked_version, instances: [instance] });
    }
  }
  for (const group of map.values()) {
    group.instances.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.dependency_type.localeCompare(b.dependency_type));
  }
  return [...map.values()];
}

/** Extract the real package name from an npm: alias range, e.g. "npm:underscore@^1" -> "underscore". */
function aliasTarget(range: string): string | null {
  if (!range.startsWith('npm:')) return null;
  const spec = range.slice(4);
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Local workspace package names (+ root) — the only zero-leak "private" signal. */
function collectWorkspaceNames(repoPath: string): Set<string> {
  const names = new Set<string>();
  const rootPkg = readPackageJson(join(repoPath, 'package.json'));
  if (rootPkg?.name) names.add(rootPkg.name);
  if (rootPkg) {
    const mono = detectMonorepo(repoPath, rootPkg);
    if (mono.is_monorepo) {
      for (const ws of expandWorkspaces(repoPath, mono.workspaces)) {
        if (ws.pkg.name) names.add(ws.pkg.name);
      }
    }
  }
  return names;
}

function resolveClients(cache: Cache, refresh: boolean, overrides?: Partial<CheckUpdatesClients>): CheckUpdatesClients {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    npm: overrides?.npm ?? createNpmRegistryClient({ cache, refresh }),
    github: overrides?.github ?? createGitHubClient({ token, cache, refresh }),
    advisories: overrides?.advisories ?? createAdvisoriesClient({ cache, refresh }),
    fetcher: overrides?.fetcher ?? defaultFetcher,
  };
}

function readStack(repoPath: string): StackJson {
  const path = join(repoPath, '.stack-radar', 'stack.json');
  const stack = readJson<StackJson>(path);
  if (!stack || !Array.isArray(stack.items)) {
    throw new Error(`No valid stack.json at ${path} — run \`stack-radar scan\` first.`);
  }
  return stack;
}
