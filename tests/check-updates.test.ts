import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Advisory } from '../src/types/update.js';
import type { GitHubClient } from '../src/update/github.js';
import { type CheckUpdatesClients, checkUpdates } from '../src/update/index.js';
import type { Packument } from '../src/update/npm-registry.js';

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-cu-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'myrepo', workspaces: ['packages/*'] }));
  mkdirSync(join(dir, 'packages', 'internal-lib'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'internal-lib', 'package.json'), JSON.stringify({ name: '@myco/internal-lib', version: '1.0.0' }));
  writeFileSync(join(dir, '.npmrc'), '@private:registry=https://npm.mycompany.com/\n');

  const item = (name: string, range: string, locked: string, workspace: string) => ({
    name,
    category: 'unknown',
    dependency_type: 'dependencies',
    current_range: range,
    locked_version: locked,
    is_direct_dependency: true,
    workspace,
    config_files: ['package.json'],
  });
  const stack = {
    schema_version: '1.0',
    scanned_at: '',
    repo: { name: 'myrepo', package_manager: 'npm', is_monorepo: true, workspaces: ['packages/*'] },
    runtime: { node_engine: null, typescript_version: null },
    items: [
      item('react', '^18.0.0', '18.2.0', 'packages/a'),
      item('react', '^17.0.0', '17.0.2', 'packages/b'), // same name, different locked version
      item('@myco/internal-lib', '^1.0.0', '1.0.0', 'packages/a'), // workspace-internal
      item('@private/thing', '^2.0.0', '2.0.0', 'packages/a'), // .npmrc private scope
      item('my-underscore', 'npm:underscore@^1.13.0', '1.13.0', 'packages/a'), // alias
      item('lodash', '^4.17.0', '4.17.20', 'packages/a'), // has advisory
    ],
  };
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack));
  return dir;
}

const PACKUMENTS: Record<string, Packument> = {
  react: { name: 'react', 'dist-tags': { latest: '18.3.1' }, repository: 'github:facebook/react', versions: { '17.0.2': { version: '17.0.2' }, '18.2.0': { version: '18.2.0' }, '18.3.1': { version: '18.3.1' } } },
  underscore: { name: 'underscore', 'dist-tags': { latest: '1.13.6' }, versions: { '1.13.0': { version: '1.13.0' }, '1.13.6': { version: '1.13.6' } } },
  lodash: { name: 'lodash', 'dist-tags': { latest: '4.17.21' }, repository: 'github:lodash/lodash', versions: { '4.17.20': { version: '4.17.20' }, '4.17.21': { version: '4.17.21' } } },
};

function fakeClients(queried: { npm: string[]; advisory: string[] }): CheckUpdatesClients {
  const github: GitHubClient = { async listReleases() { return []; } };
  return {
    npm: {
      async getPackument(name) {
        queried.npm.push(name);
        return PACKUMENTS[name] ?? null;
      },
    },
    github,
    advisories: {
      async query(queries) {
        const map = new Map<string, Advisory[]>();
        for (const q of queries) {
          queried.advisory.push(q.name);
          map.set(`${q.name}@${q.version}`, q.name === 'lodash' ? [{ id: 'GHSA-x', source: 'osv' }] : []);
        }
        return map;
      },
    },
    fetcher: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }),
  };
}

describe('checkUpdates (orchestration)', () => {
  it('skips internal/private, resolves aliases, splits versions, maps advisories', async () => {
    const dir = setupRepo();
    const queried = { npm: [] as string[], advisory: [] as string[] };
    const records = await checkUpdates(dir, { clients: fakeClients(queried) });
    const find = (name: string, locked: string) => records.find((r) => r.name === name && r.locked_version === locked);

    // same name, two locked versions -> two records with version-specific update_type
    expect(find('react', '18.2.0')?.update_type).toBe('minor');
    expect(find('react', '17.0.2')?.update_type).toBe('major');

    // workspace package skipped and never sent externally
    expect(find('@myco/internal-lib', '1.0.0')?.status).toBe('skipped_private');
    expect(queried.npm).not.toContain('@myco/internal-lib');
    expect(queried.advisory).not.toContain('@myco/internal-lib');

    // a non-workspace package absent from public npm -> queried, then not_found
    // (we don't infer privacy from the .npmrc registry — it's usually a mirror)
    expect(find('@private/thing', '2.0.0')?.status).toBe('not_found');
    expect(queried.npm).toContain('@private/thing');

    // alias resolves to the real package name; the alias name is never sent
    const alias = find('my-underscore', '1.13.0');
    expect(alias?.resolved_name).toBe('underscore');
    expect(alias?.latest_version).toBe('1.13.6');
    expect(queried.npm).toContain('underscore');
    expect(queried.npm).not.toContain('my-underscore');

    // advisory drives the security signal
    const lodash = find('lodash', '4.17.20');
    expect(lodash?.advisories).toHaveLength(1);
    expect(lodash?.signals.security).toBe(true);
  });

  it('is deterministic across runs', async () => {
    const dir = setupRepo();
    const a = await checkUpdates(dir, { clients: fakeClients({ npm: [], advisory: [] }) });
    const b = await checkUpdates(dir, { clients: fakeClients({ npm: [], advisory: [] }) });
    expect(a).toEqual(b);
  });

  it('marks records partial (not clean) when the advisory lookup fails', async () => {
    const dir = setupRepo();
    const clients = fakeClients({ npm: [], advisory: [] });
    clients.advisories = {
      async query() {
        throw new Error('OSV down');
      },
    };
    const records = await checkUpdates(dir, { clients });
    const lodash = records.find((r) => r.name === 'lodash' && r.locked_version === '4.17.20');
    expect(lodash?.status).toBe('partial');
    expect(lodash?.signals.security).toBe(false);
    expect(lodash?.note).toMatch(/advisory check unavailable/);
  });

  it('extracts latest-version requirements (sorted peers, optional, engines.node)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-req-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'r' }));
    mkdirSync(join(dir, '.stack-radar'), { recursive: true });
    writeFileSync(
      join(dir, '.stack-radar', 'stack.json'),
      JSON.stringify({
        schema_version: '1.0',
        scanned_at: '',
        repo: { name: 'r', package_manager: 'npm', is_monorepo: false, workspaces: [] },
        runtime: { node_engine: null, typescript_version: null },
        items: [
          { name: 'fancy', category: 'unknown', dependency_type: 'dependencies', current_range: '^1', locked_version: '1.0.0', is_direct_dependency: true, workspace: '.', config_files: ['package.json'] },
        ],
      }),
    );
    const clients: CheckUpdatesClients = {
      npm: {
        async getPackument() {
          return {
            name: 'fancy',
            'dist-tags': { latest: '2.0.0' },
            versions: {
              '1.0.0': { version: '1.0.0' },
              '2.0.0': {
                version: '2.0.0',
                engines: { node: '>=18' },
                peerDependencies: { zebra: '^1', alpha: '^2' }, // out of order on purpose
                peerDependenciesMeta: { zebra: { optional: true } },
              },
            },
          };
        },
      },
      github: { async listReleases() { return []; } },
      advisories: { async query() { return new Map(); } },
      fetcher: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }),
    };
    const records = await checkUpdates(dir, { clients });
    const fancy = records.find((r) => r.name === 'fancy');
    expect(fancy?.requirements.node).toBe('>=18');
    expect(Object.keys(fancy?.requirements.peers ?? {})).toEqual(['alpha', 'zebra']); // sorted
    expect(fancy?.requirements.optional_peers).toEqual(['zebra']);
  });

  it('does NOT block public lookups just because a (mirror) default registry is set', async () => {
    const dir = setupRepo();
    writeFileSync(join(dir, '.npmrc'), 'registry=https://npm.mycompany.com/\n'); // usually a mirror
    const queried = { npm: [] as string[], advisory: [] as string[] };

    const records = await checkUpdates(dir, { clients: fakeClients(queried) });
    // public packages are still queried (the mirror serves them too)
    expect(queried.npm).toContain('react');
    expect(records.some((r) => r.status === 'ok')).toBe(true);
    // only the local workspace package is withheld
    expect(records.find((r) => r.name === '@myco/internal-lib')?.status).toBe('skipped_private');
    expect(queried.npm).not.toContain('@myco/internal-lib');
  });
});
