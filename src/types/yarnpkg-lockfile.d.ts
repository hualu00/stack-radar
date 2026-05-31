/**
 * Ambient types for `@yarnpkg/lockfile` (Yarn classic v1 parser), which ships
 * no type declarations. Modeled as a CommonJS module; import with a default
 * import (`import yarnLockfile from '@yarnpkg/lockfile'`) and call
 * `yarnLockfile.parse(...)`.
 */
declare module '@yarnpkg/lockfile' {
  export interface FirstLevelDependency {
    version: string;
    resolved?: string;
    integrity?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }

  export interface ParseResult {
    type: 'success' | 'merge' | 'conflict';
    /** Keyed by individual `name@range` descriptors (comma-separated keys are expanded). */
    object: Record<string, FirstLevelDependency>;
  }

  export function parse(content: string): ParseResult;
  export function stringify(obj: Record<string, FirstLevelDependency>): string;
}
