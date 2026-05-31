import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageJson } from '../src/scanner/package-json.js';
import { detectMonorepo, expandWorkspaces } from '../src/scanner/workspace.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const fx = (name: string) => join(FIXTURES, name);
const pkg = (name: string) => readPackageJson(join(fx(name), 'package.json'));

describe('detectMonorepo', () => {
  it('detects a pnpm workspace', () => {
    const r = detectMonorepo(fx('pnpm-mono'), pkg('pnpm-mono'));
    expect(r.is_monorepo).toBe(true);
    expect(r.workspaces).toEqual(['packages/*']);
  });

  it('detects a package.json workspaces array', () => {
    const r = detectMonorepo(fx('npm-mono'), pkg('npm-mono'));
    expect(r.is_monorepo).toBe(true);
    expect(r.workspaces).toEqual(['packages/*']);
  });

  it('reads the workspaces object form ({ packages })', () => {
    const r = detectMonorepo(fx('npm-simple'), { workspaces: { packages: ['libs/*'] } });
    expect(r.is_monorepo).toBe(true);
    expect(r.workspaces).toEqual(['libs/*']);
  });

  it('reports a single package as not a monorepo', () => {
    const r = detectMonorepo(fx('npm-simple'), pkg('npm-simple'));
    expect(r.is_monorepo).toBe(false);
    expect(r.workspaces).toEqual([]);
  });
});

describe('expandWorkspaces', () => {
  it('finds workspace package directories', () => {
    const dirs = expandWorkspaces(fx('pnpm-mono'), ['packages/*']).map((w) => w.dir).sort();
    expect(dirs).toEqual(['packages/app', 'packages/ui']);
  });

  it('returns empty when there are no patterns', () => {
    expect(expandWorkspaces(fx('npm-simple'), [])).toEqual([]);
  });
});
