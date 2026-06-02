import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRepo } from '../src/scanner/index.js';
import { nvmrcToRange } from '../src/scanner/nvmrc.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const fx = (name: string) => join(FIXTURES, name);

describe('scanRepo — npm-simple', () => {
  const s = scanRepo(fx('npm-simple'));

  it('produces the expected top-level shape', () => {
    expect(s.schema_version).toBe('1.0');
    expect(s.repo.package_manager).toBe('npm');
    expect(s.repo.is_monorepo).toBe(false);
    expect(s.runtime.node_engine).toBe('>=18');
    expect(s.runtime.nvmrc).toBe('v20.19');
    expect(s.runtime.typescript_version).toBe('5.4.5');
  });

  it('emits only direct dependencies (no transitive leakage)', () => {
    const names = s.items.map((i) => i.name).sort();
    expect(names).toEqual(['lodash', 'react', 'typescript', 'vitest']);
    expect(s.items.every((i) => i.is_direct_dependency)).toBe(true);
    expect(names).not.toContain('loose-envify');
    expect(names).not.toContain('js-tokens');
  });

  it('resolves locked versions from the lockfile', () => {
    const byName = Object.fromEntries(s.items.map((i) => [i.name, i.locked_version]));
    expect(byName).toMatchObject({
      react: '18.3.1',
      lodash: '4.17.21',
      typescript: '5.4.5',
      vitest: '1.6.1',
    });
  });

  it('is deterministic across runs (ignoring scanned_at)', () => {
    const a = scanRepo(fx('npm-simple'));
    const b = scanRepo(fx('npm-simple'));
    expect({ ...a, scanned_at: '' }).toEqual({ ...b, scanned_at: '' });
  });
});

describe('scanRepo — pnpm-mono (workspace attribution)', () => {
  const s = scanRepo(fx('pnpm-mono'));
  const find = (name: string, ws: string) => s.items.find((i) => i.name === name && i.workspace === ws);

  it('flags monorepo and workspace patterns', () => {
    expect(s.repo.is_monorepo).toBe(true);
    expect(s.repo.workspaces).toEqual(['packages/*']);
  });

  it('attributes each item to its owning workspace with correct locked versions', () => {
    expect(find('typescript', '.')?.locked_version).toBe('5.5.4');
    expect(find('react', 'packages/app')?.locked_version).toBe('18.3.1');
    expect(find('@tanstack/react-query', 'packages/ui')?.locked_version).toBe('5.59.16');
    // workspace: link → backfilled from the local ui package's own version
    expect(find('ui', 'packages/app')?.locked_version).toBe('1.0.0');
    expect(find('cat-pkg', 'packages/app')?.locked_version).toBe('3.2.1'); // catalog:
    expect(find('old-pkg', 'packages/ui')?.locked_version).toBeNull(); // stale specifier, not a workspace pkg
  });

  it('gives every item a non-empty workspace field', () => {
    expect(s.items.every((i) => typeof i.workspace === 'string' && i.workspace.length > 0)).toBe(true);
  });
});

describe('scanRepo — npm-mono (per-workspace resolution)', () => {
  const s = scanRepo(fx('npm-mono'));

  it('sets runtime.nvmrc to null when absent', () => {
    expect(s.runtime.nvmrc).toBeNull();
  });

  it('resolves hoisted vs local versions per workspace', () => {
    expect(s.items.find((i) => i.name === 'react' && i.workspace === 'packages/a')?.locked_version).toBe('18.2.0');
    expect(s.items.find((i) => i.name === 'react' && i.workspace === 'packages/b')?.locked_version).toBe('17.0.2');
  });
});

describe('nvmrcToRange', () => {
  it('normalizes .nvmrc values into semver ranges', () => {
    expect(nvmrcToRange('24')).toBe('24.x');
    expect(nvmrcToRange('v24')).toBe('24.x');
    expect(nvmrcToRange('20.19')).toBe('20.19.x');
    expect(nvmrcToRange('20.19.0')).toBe('20.19.0');
  });

  it('returns null for unsupported, blank, or missing values', () => {
    expect(nvmrcToRange('lts/iron')).toBeNull();
    expect(nvmrcToRange('')).toBeNull();
    expect(nvmrcToRange(null)).toBeNull();
  });
});
