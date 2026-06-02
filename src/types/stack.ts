/**
 * Types for `.stack-radar/stack.json` — the output of the `scan` command.
 * Mirrors the schema in PLAN.md §4 (Module 1: Stack Scanner).
 */

/** Category enum — PLAN.md §4 "Category 枚举". */
export type Category =
  | 'framework'
  | 'bundler'
  | 'compiler'
  | 'linter'
  | 'formatter'
  | 'test'
  | 'state'
  | 'routing'
  | 'ui-lib'
  | 'data-fetching'
  | 'monorepo'
  | 'ci'
  | 'utility'
  | 'runtime'
  | 'build-plugin'
  | 'unknown';

/** Where a dependency is declared in a package.json. */
export type DependencyType =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies';

/** Detected package manager for the scanned repo. */
export type PackageManager = 'yarn' | 'pnpm' | 'npm';

/** Repo-level metadata. */
export interface RepoInfo {
  name: string;
  package_manager: PackageManager;
  is_monorepo: boolean;
  /** Workspace glob patterns (e.g. ["packages/*", "apps/*"]); empty when not a monorepo. */
  workspaces: string[];
}

/** Runtime constraints extracted from the repo. */
export interface RuntimeInfo {
  /** From root package.json `engines.node`; null when absent. */
  node_engine: string | null;
  /** Raw first non-empty line from root `.nvmrc`; null when absent or empty. */
  nvmrc: string | null;
  /** Locked version of `typescript` (falls back to its declared range, then null). */
  typescript_version: string | null;
}

/**
 * A single dependency entry. Only DIRECT dependencies (declared in a
 * package.json) become items — transitive deps are never emitted in M1.
 */
export interface StackItem {
  name: string;
  category: Category;
  dependency_type: DependencyType;
  /** The range declared in package.json, e.g. "^18.3.1". */
  current_range: string;
  /**
   * Resolved version from the lockfile. `null` when it cannot be expressed as
   * a registry semver (e.g. `workspace:`/`link:`/`file:`/`portal:` protocols)
   * or when the lockfile has no matching entry.
   */
  locked_version: string | null;
  /** Always true in M1 — items only come from declared dependencies. */
  is_direct_dependency: boolean;
  /** Owning workspace path; "." for the repo root. */
  workspace: string;
  /** Config files that configure this tool; always includes "package.json". */
  config_files: string[];
}

/** Top-level shape of `.stack-radar/stack.json`. */
export interface StackJson {
  schema_version: '1.0';
  /** ISO-8601 timestamp of the scan. */
  scanned_at: string;
  repo: RepoInfo;
  runtime: RuntimeInfo;
  items: StackItem[];
}
