import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PackageManager } from '../types/stack.js';
import { fileExists, readText } from '../utils/fs.js';
import type { PackageJson } from './package-json.js';

// @yarnpkg/lockfile is a CommonJS webpack bundle whose named exports are not
// statically detectable by Node's ESM loader. Load it via createRequire so the
// real module.exports (with `parse`) is available across Node and Vitest.
const nodeRequire = createRequire(import.meta.url);
const { parse: parseYarnLock } = nodeRequire('@yarnpkg/lockfile') as typeof import('@yarnpkg/lockfile');

/**
 * Resolves the locked version for a declared dependency.
 * @param workspaceDir Owning workspace relative dir; "." for the repo root.
 * @returns A registry semver, or null when unresolvable (missing entry, or a
 *          non-registry protocol like workspace:/link:/file:/portal:).
 */
export type VersionResolver = (
  name: string,
  range: string,
  workspaceDir: string,
) => string | null;

const NEVER_RESOLVES: VersionResolver = () => null;

const LOCKFILES = {
  yarn: 'yarn.lock',
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
} as const;

/** Detect the package manager from the `packageManager` field, then lockfile presence. */
export function detectPackageManager(repoPath: string, rootPkg: PackageJson | null): PackageManager {
  const field = rootPkg?.packageManager;
  if (field) {
    if (field.startsWith('yarn')) return 'yarn';
    if (field.startsWith('pnpm')) return 'pnpm';
    if (field.startsWith('npm')) return 'npm';
  }
  if (fileExists(join(repoPath, LOCKFILES.yarn))) return 'yarn';
  if (fileExists(join(repoPath, LOCKFILES.pnpm))) return 'pnpm';
  if (fileExists(join(repoPath, LOCKFILES.npm))) return 'npm';
  return 'npm';
}

export function buildVersionResolver(repoPath: string, pm: PackageManager): VersionResolver {
  switch (pm) {
    case 'yarn':
      return buildYarnResolver(repoPath);
    case 'pnpm':
      return buildPnpmResolver(repoPath);
    case 'npm':
      return buildNpmResolver(repoPath);
  }
}

// ---------------------------------------------------------------------------
// Shared descriptor index (used by both yarn classic and berry)
// ---------------------------------------------------------------------------

interface IndexEntry {
  /** The post-name descriptor range, e.g. "^18.3.1", "npm:^18.3.1", "workspace:packages/a". */
  range: string;
  version: string;
}

type DescriptorIndex = Map<string, IndexEntry[]>;

/** Split a descriptor into name + range, honoring scoped (`@scope/x`) packages. */
function splitDescriptor(descriptor: string): { name: string; range: string } | null {
  const at = descriptor.startsWith('@') ? descriptor.indexOf('@', 1) : descriptor.indexOf('@');
  if (at <= 0) return null;
  return { name: descriptor.slice(0, at), range: descriptor.slice(at + 1) };
}

function addToIndex(index: DescriptorIndex, name: string, range: string, version: string): void {
  const list = index.get(name);
  if (list) list.push({ range, version });
  else index.set(name, [{ range, version }]);
}

/** Strip only a leading `npm:` protocol (the registry protocol). */
function stripNpm(range: string): string {
  return range.startsWith('npm:') ? range.slice(4) : range;
}

/**
 * Whether a descriptor range resolves to a real registry version. Plain semver,
 * `npm:` (incl. aliases), and `patch:` do; local protocols (workspace:/link:/
 * file:/portal:/exec:/git:/http:) do not — those must yield null.
 */
function isResolvableProtocol(range: string): boolean {
  if (range.startsWith('npm:') || range.startsWith('patch:')) return true;
  // Any other URI-like protocol (workspace:/link:/file:/portal:/git+ssh:/http: ...) is non-registry.
  return !/^[a-z][a-z0-9+.-]*:/i.test(range);
}

/**
 * Resolve against a descriptor index by exact / npm-prefixed / npm-stripped
 * match. No single-candidate fallback: a non-matching candidate must not be
 * mistaken for the declared range (codex). Matches on a non-registry protocol
 * return null rather than a misleading local version.
 */
function resolveFromIndex(index: DescriptorIndex, name: string, pkgRange: string): string | null {
  const candidates = index.get(name);
  if (!candidates || candidates.length === 0) return null;

  const match = candidates.find(
    (c) => c.range === pkgRange || c.range === `npm:${pkgRange}` || stripNpm(c.range) === pkgRange,
  );
  if (!match) return null;
  if (!isResolvableProtocol(match.range)) return null;
  // Yarn Berry stamps workspace packages with this marker, not a real version.
  if (!match.version || match.version === '0.0.0-use.local') return null;
  return match.version;
}

// ---------------------------------------------------------------------------
// Yarn (classic v1 + Berry v2-4)
// ---------------------------------------------------------------------------

function buildYarnResolver(repoPath: string): VersionResolver {
  const content = readText(join(repoPath, LOCKFILES.yarn));
  if (content === null) return NEVER_RESOLVES;

  const index: DescriptorIndex = content.includes('__metadata')
    ? buildBerryIndex(content)
    : buildClassicIndex(content);

  return (name, range) => resolveFromIndex(index, name, range);
}

function buildClassicIndex(content: string): DescriptorIndex {
  const index: DescriptorIndex = new Map();
  let parsed;
  try {
    parsed = parseYarnLock(content);
  } catch {
    return index;
  }
  for (const [descriptor, entry] of Object.entries(parsed.object)) {
    if (!entry?.version) continue;
    const split = splitDescriptor(descriptor);
    if (split) addToIndex(index, split.name, split.range, entry.version);
  }
  return index;
}

function buildBerryIndex(content: string): DescriptorIndex {
  const index: DescriptorIndex = new Map();
  let doc: Record<string, unknown> | null;
  try {
    doc = parseYaml(content) as Record<string, unknown> | null;
  } catch {
    return index;
  }
  if (!doc) return index;

  for (const [key, value] of Object.entries(doc)) {
    if (key === '__metadata') continue;
    const version = (value as { version?: unknown } | null)?.version;
    if (typeof version !== 'string') continue;
    // A key may bundle multiple comma-separated descriptors.
    for (const descriptor of key.split(',')) {
      const split = splitDescriptor(descriptor.trim());
      if (split) addToIndex(index, split.name, split.range, version);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// pnpm (lockfile v9 — parsed directly as YAML)
// ---------------------------------------------------------------------------

type PnpmSpec = { specifier?: string; version?: string } | string;
interface PnpmImporter {
  dependencies?: Record<string, PnpmSpec>;
  devDependencies?: Record<string, PnpmSpec>;
  optionalDependencies?: Record<string, PnpmSpec>;
}
interface PnpmLock {
  importers?: Record<string, PnpmImporter>;
  dependencies?: Record<string, PnpmSpec>;
  devDependencies?: Record<string, PnpmSpec>;
  optionalDependencies?: Record<string, PnpmSpec>;
}

const PNPM_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

function cleanPnpmVersion(raw: string): string | null {
  if (
    raw.startsWith('link:') ||
    raw.startsWith('file:') ||
    raw.startsWith('workspace:') ||
    raw.startsWith('catalog:')
  ) {
    return null;
  }
  // Strip a trailing peer-deps suffix: "1.2.3(react@18.3.1)" -> "1.2.3".
  const cut = raw.indexOf('(');
  let version = (cut === -1 ? raw : raw.slice(0, cut)).trim();
  // Alias forms: "npm:bar@1.2.3", "bar@1.2.3", "@scope/bar@1.2.3" -> keep the version.
  if (version.startsWith('npm:')) version = version.slice(4);
  const at = version.lastIndexOf('@');
  if (at > 0) version = version.slice(at + 1);
  // Must look like a real version; otherwise we cannot trust it.
  if (!/^\d/.test(version)) return null;
  return version;
}

function buildPnpmResolver(repoPath: string): VersionResolver {
  const content = readText(join(repoPath, LOCKFILES.pnpm));
  if (content === null) return NEVER_RESOLVES;

  let lock: PnpmLock | null;
  try {
    lock = parseYaml(content) as PnpmLock | null;
  } catch {
    return NEVER_RESOLVES;
  }
  if (!lock) return NEVER_RESOLVES;

  return (name, range, workspaceDir) => {
    const importerKey = workspaceDir === '.' ? '.' : workspaceDir;
    const importer: PnpmImporter | undefined = lock.importers?.[importerKey] ?? (importerKey === '.' ? lock : undefined);
    if (!importer) return null;

    for (const block of PNPM_BLOCKS) {
      const entry = importer[block]?.[name];
      if (entry === undefined) continue;
      if (typeof entry === 'string') return cleanPnpmVersion(entry);
      // Object form: guard against a stale lockfile by checking the recorded
      // specifier against the declared range (catalog: specifiers are exempt).
      const spec = entry.specifier;
      if (typeof spec === 'string' && spec !== range && !spec.startsWith('catalog:')) {
        return null;
      }
      return typeof entry.version === 'string' ? cleanPnpmVersion(entry.version) : null;
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// npm (package-lock.json v1 / v2 / v3)
// ---------------------------------------------------------------------------

interface NpmLock {
  packages?: Record<string, { version?: string }>;
  dependencies?: Record<string, { version?: string }>;
}

function buildNpmResolver(repoPath: string): VersionResolver {
  const content = readText(join(repoPath, LOCKFILES.npm));
  if (content === null) return NEVER_RESOLVES;

  let lock: NpmLock | null;
  try {
    lock = JSON.parse(content) as NpmLock;
  } catch {
    return NEVER_RESOLVES;
  }
  if (!lock) return NEVER_RESOLVES;

  const packages = lock.packages;
  const flatDeps = lock.dependencies;

  return (name, _range, workspaceDir) => {
    if (packages) {
      // v2/v3: prefer workspace-local install, then root-hoisted.
      const prefix = workspaceDir === '.' ? '' : `${workspaceDir}/`;
      const localKey = `${prefix}node_modules/${name}`;
      const rootKey = `node_modules/${name}`;
      return packages[localKey]?.version ?? packages[rootKey]?.version ?? null;
    }
    if (flatDeps) {
      // v1: only the (hoisted) top level is consulted.
      return flatDeps[name]?.version ?? null;
    }
    return null;
  };
}
