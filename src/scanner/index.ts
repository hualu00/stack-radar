import { basename, join } from 'node:path';
import type { RuntimeInfo, StackItem, StackJson } from '../types/stack.js';
import { getCategory } from './category.js';
import { detectConfigFiles } from './config-files.js';
import { buildVersionResolver, detectPackageManager, type VersionResolver } from './lockfile.js';
import {
  extractDependencies,
  getNodeEngine,
  getTypescriptRange,
  type PackageJson,
  readPackageJson,
} from './package-json.js';
import { detectMonorepo, expandWorkspaces } from './workspace.js';

interface ScanUnit {
  /** Workspace dir relative to repo root; "." for the root package. */
  dir: string;
  pkg: PackageJson;
}

/** Scan a repo and produce its stack.json model. Pure read-only over the filesystem. */
export function scanRepo(repoPath: string): StackJson {
  const rootPkg = readPackageJson(join(repoPath, 'package.json'));
  if (!rootPkg) {
    throw new Error(`No package.json found at ${join(repoPath, 'package.json')}`);
  }

  const pm = detectPackageManager(repoPath, rootPkg);
  const resolve = buildVersionResolver(repoPath, pm);
  const mono = detectMonorepo(repoPath, rootPkg);

  const units: ScanUnit[] = [{ dir: '.', pkg: rootPkg }];
  if (mono.is_monorepo) {
    for (const ws of expandWorkspaces(repoPath, mono.workspaces)) {
      units.push({ dir: ws.dir, pkg: ws.pkg });
    }
  }

  // Local workspace package versions, for backfilling internal deps that the
  // lockfile records as a workspace link / 0.0.0-use.local marker rather than
  // a real version.
  const workspaceVersions = new Map<string, string>();
  for (const unit of units) {
    if (unit.pkg.name && unit.pkg.version) workspaceVersions.set(unit.pkg.name, unit.pkg.version);
  }

  const items: StackItem[] = [];
  for (const unit of units) {
    const absDir = unit.dir === '.' ? repoPath : join(repoPath, unit.dir);
    const configByPackage = detectConfigFiles(absDir);

    for (const dep of extractDependencies(unit.pkg)) {
      const locked = resolve(dep.name, dep.range, unit.dir) ?? workspaceVersions.get(dep.name) ?? null;
      items.push({
        name: dep.name,
        category: getCategory(dep.name),
        dependency_type: dep.dependency_type,
        current_range: dep.range,
        locked_version: locked,
        is_direct_dependency: true,
        workspace: unit.dir,
        config_files: ['package.json', ...(configByPackage.get(dep.name) ?? [])],
      });
    }
  }

  // Deterministic ordering: workspace, then name, then dependency_type.
  items.sort(
    (a, b) =>
      a.workspace.localeCompare(b.workspace) ||
      a.name.localeCompare(b.name) ||
      a.dependency_type.localeCompare(b.dependency_type),
  );

  const runtime: RuntimeInfo = {
    node_engine: getNodeEngine(rootPkg),
    typescript_version: resolveTypescriptVersion(rootPkg, resolve),
  };

  return {
    schema_version: '1.0',
    scanned_at: new Date().toISOString(),
    repo: {
      name: rootPkg.name ?? basename(repoPath),
      package_manager: pm,
      is_monorepo: mono.is_monorepo,
      workspaces: mono.workspaces,
    },
    runtime,
    items,
  };
}

/** typescript locked version → declared range → null. */
function resolveTypescriptVersion(rootPkg: PackageJson, resolve: VersionResolver): string | null {
  const range = getTypescriptRange(rootPkg);
  if (!range) return null;
  return resolve('typescript', range, '.') ?? range;
}
