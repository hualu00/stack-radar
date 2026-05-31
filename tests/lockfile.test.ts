import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVersionResolver, detectPackageManager } from '../src/scanner/lockfile.js';
import { readPackageJson } from '../src/scanner/package-json.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const fx = (name: string) => join(FIXTURES, name);
const pkg = (name: string) => readPackageJson(join(fx(name), 'package.json'));

describe('detectPackageManager', () => {
  it('detects from lockfile presence', () => {
    expect(detectPackageManager(fx('npm-simple'), pkg('npm-simple'))).toBe('npm');
    expect(detectPackageManager(fx('yarn-classic'), pkg('yarn-classic'))).toBe('yarn');
    expect(detectPackageManager(fx('yarn-berry'), pkg('yarn-berry'))).toBe('yarn');
    expect(detectPackageManager(fx('pnpm-mono'), pkg('pnpm-mono'))).toBe('pnpm');
  });

  it('prefers the packageManager field over lockfile presence', () => {
    expect(detectPackageManager(fx('yarn-berry'), { packageManager: 'yarn@4.0.0' })).toBe('yarn');
    expect(detectPackageManager(fx('npm-simple'), { packageManager: 'pnpm@10.0.0' })).toBe('pnpm');
  });
});

describe('npm resolver (single package)', () => {
  const resolve = buildVersionResolver(fx('npm-simple'), 'npm');
  it('resolves direct deps from the root', () => {
    expect(resolve('react', '^18.3.1', '.')).toBe('18.3.1');
    expect(resolve('typescript', '^5.4.0', '.')).toBe('5.4.5');
    expect(resolve('vitest', '^1.6.0', '.')).toBe('1.6.1');
  });
  it('returns null for an absent package', () => {
    expect(resolve('does-not-exist', '^1.0.0', '.')).toBeNull();
  });
});

describe('npm resolver (workspaces: hoist vs local)', () => {
  const resolve = buildVersionResolver(fx('npm-mono'), 'npm');
  it('uses the hoisted root install when not present locally', () => {
    expect(resolve('react', '^18.0.0', 'packages/a')).toBe('18.2.0');
  });
  it('prefers the workspace-local install on version conflict', () => {
    expect(resolve('react', '^17.0.0', 'packages/b')).toBe('17.0.2');
  });
  it('resolves a root devDependency', () => {
    expect(resolve('typescript', '^5.4.0', '.')).toBe('5.4.5');
  });
});

describe('yarn classic (v1) resolver', () => {
  const resolve = buildVersionResolver(fx('yarn-classic'), 'yarn');
  it('resolves plain and scoped descriptors', () => {
    expect(resolve('react', '^18.0.0', '.')).toBe('18.2.0');
    expect(resolve('@scope/pkg', '^1.2.0', '.')).toBe('1.2.3');
    expect(resolve('left-pad', '^1.3.0', '.')).toBe('1.3.0');
  });
});

describe('yarn berry (v4) resolver', () => {
  const resolve = buildVersionResolver(fx('yarn-berry'), 'yarn');
  it('resolves npm / scoped / alias / patched descriptors', () => {
    expect(resolve('react', '^18.3.1', '.')).toBe('18.3.1');
    expect(resolve('@scope/ui', '^2.0.0', '.')).toBe('2.1.0');
    expect(resolve('my-alias', 'npm:underscore@^1.13.0', '.')).toBe('1.13.6');
    // declared range matches the npm: descriptor, not the patch: one
    expect(resolve('lodash', '^4.17.21', '.')).toBe('4.17.21');
  });
  it('returns null for a non-registry protocol (link:)', () => {
    expect(resolve('some-link', 'link:../foo', '.')).toBeNull();
  });
  it('returns null for the workspace marker (0.0.0-use.local) instead of the marker', () => {
    expect(resolve('internal-lib', '^1.0.0', '.')).toBeNull();
  });
});

describe('pnpm resolver (v9, importers)', () => {
  const resolve = buildVersionResolver(fx('pnpm-mono'), 'pnpm');
  it('resolves per-importer and strips peer-deps suffix', () => {
    expect(resolve('typescript', '^5.5.0', '.')).toBe('5.5.4');
    expect(resolve('react', '^18.3.1', 'packages/app')).toBe('18.3.1');
    expect(resolve('@tanstack/react-query', '^5.59.0', 'packages/ui')).toBe('5.59.16');
  });
  it('returns null for a workspace link', () => {
    expect(resolve('ui', 'workspace:*', 'packages/app')).toBeNull();
  });
  it('resolves a catalog: dependency to its concrete version', () => {
    expect(resolve('cat-pkg', 'catalog:', 'packages/app')).toBe('3.2.1');
  });
  it('returns null when the recorded specifier is stale', () => {
    expect(resolve('old-pkg', '^2.0.0', 'packages/ui')).toBeNull();
  });
  it('extracts the version from an alias (npm:real-pkg) entry', () => {
    expect(resolve('aliased', 'npm:real-pkg@^1.0.0', 'packages/app')).toBe('1.2.3');
  });
});
