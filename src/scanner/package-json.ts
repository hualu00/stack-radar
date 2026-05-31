import type { DependencyType } from '../types/stack.js';
import { readJson } from '../utils/fs.js';

/** A minimal, permissive view of a package.json relevant to scanning. */
export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  /** Present when the package ships an executable (a CLI/tool). */
  bin?: string | Record<string, string>;
  /** e.g. "yarn@4.14.1", "pnpm@10.0.0", "npm@11.0.0" */
  packageManager?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export interface DeclaredDependency {
  name: string;
  range: string;
  dependency_type: DependencyType;
}

/** The dependency blocks scanned in M1 (optionalDependencies intentionally excluded per the guide). */
const DEP_BLOCKS: DependencyType[] = ['dependencies', 'devDependencies', 'peerDependencies'];

export function readPackageJson(path: string): PackageJson | null {
  return readJson<PackageJson>(path);
}

/**
 * Flatten declared dependencies across dependencies/devDependencies/peerDependencies.
 * Every entry here is a DIRECT dependency — transitive deps never appear.
 */
export function extractDependencies(pkg: PackageJson): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  for (const block of DEP_BLOCKS) {
    const deps = pkg[block];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      out.push({ name, range, dependency_type: block });
    }
  }
  return out;
}

/** Root `engines.node`, or null when absent. */
export function getNodeEngine(pkg: PackageJson): string | null {
  return pkg.engines?.node ?? null;
}

/** Declared range of `typescript` across any dependency block, or null. */
export function getTypescriptRange(pkg: PackageJson): string | null {
  return (
    pkg.dependencies?.typescript ??
    pkg.devDependencies?.typescript ??
    pkg.peerDependencies?.typescript ??
    null
  );
}
