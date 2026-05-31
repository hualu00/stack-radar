import { dirname, join } from 'node:path';
import { globSync } from 'tinyglobby';
import { parse as parseYaml } from 'yaml';
import { fileExists, readText } from '../utils/fs.js';
import { type PackageJson, readPackageJson } from './package-json.js';

export interface MonorepoInfo {
  is_monorepo: boolean;
  /** Workspace glob patterns, deduped, in declaration order. */
  workspaces: string[];
}

export interface WorkspacePackage {
  /** Directory relative to the repo root, e.g. "packages/a". */
  dir: string;
  pkg: PackageJson;
}

const MONOREPO_TOOL_FILES = ['turbo.json', 'nx.json', 'lerna.json'];

/**
 * Detect monorepo status and collect workspace patterns from:
 * pnpm-workspace.yaml `packages:`, package.json `workspaces`, and the presence
 * of turbo/nx/lerna config.
 */
export function detectMonorepo(repoPath: string, rootPkg: PackageJson | null): MonorepoInfo {
  const patterns: string[] = [];

  const pnpmWs = readText(join(repoPath, 'pnpm-workspace.yaml'));
  if (pnpmWs) {
    try {
      const doc = parseYaml(pnpmWs) as { packages?: unknown } | null;
      if (doc && Array.isArray(doc.packages)) {
        patterns.push(...doc.packages.filter((p): p is string => typeof p === 'string'));
      }
    } catch {
      // Malformed pnpm-workspace.yaml: ignore rather than crash the scan.
    }
  }

  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) {
    patterns.push(...ws);
  } else if (ws && Array.isArray(ws.packages)) {
    patterns.push(...ws.packages);
  }

  const hasMonorepoTool = MONOREPO_TOOL_FILES.some((f) => fileExists(join(repoPath, f)));
  const workspaces = [...new Set(patterns)];
  const is_monorepo = workspaces.length > 0 || hasMonorepoTool;

  return { is_monorepo, workspaces };
}

/** Convert a workspace pattern into a `<pattern>/package.json` glob, preserving `!` negation. */
function toPackageJsonGlob(pattern: string): string {
  if (pattern.startsWith('!')) {
    return `!${pattern.slice(1).replace(/\/+$/, '')}/package.json`;
  }
  return `${pattern.replace(/\/+$/, '')}/package.json`;
}

/**
 * Expand workspace patterns to concrete workspace packages. Uses tinyglobby
 * (handles `**`, braces, `!` negation) and prunes node_modules/.git.
 */
export function expandWorkspaces(repoPath: string, patterns: string[]): WorkspacePackage[] {
  if (patterns.length === 0) return [];

  const globs = patterns.map(toPackageJsonGlob);
  const matches = globSync(globs, {
    cwd: repoPath,
    ignore: ['**/node_modules/**', '**/.git/**'],
    dot: false,
  });

  const out: WorkspacePackage[] = [];
  for (const rel of matches.sort()) {
    const dir = dirname(rel);
    if (dir === '.' || dir === '') continue; // never treat the root as a workspace
    const pkg = readPackageJson(join(repoPath, rel));
    if (pkg) out.push({ dir, pkg });
  }
  return out;
}
