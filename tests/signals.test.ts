import { describe, expect, it } from 'vitest';
import type { Advisory } from '../src/types/update.js';
import type { VersionText } from '../src/update/changelog.js';
import type { Packument } from '../src/update/npm-registry.js';
import { detectSignals } from '../src/update/signals.js';

const text = (body: string): VersionText[] => [{ version: '2.0.0', text: body }];
const noTexts: VersionText[] = [];

describe('detectSignals — security', () => {
  it('is true when advisories are present', () => {
    const advisories: Advisory[] = [{ id: 'GHSA-x', source: 'osv' }];
    expect(detectSignals({ packument: null, locked: '1.0.0', latest: '2.0.0', advisories, texts: noTexts }).signals.security).toBe(true);
  });
});

describe('detectSignals — breaking (with false-positive suppression)', () => {
  const run = (body: string) =>
    detectSignals({ packument: null, locked: '1.0.0', latest: '2.0.0', advisories: [], texts: text(body) }).signals.breaking;

  it('detects BREAKING CHANGE and conventional !: markers', () => {
    expect(run('BREAKING CHANGE: removed the old API')).toBe(true);
    expect(run('This release has breaking changes to the config')).toBe(true);
    expect(run('feat!: drop node 16 support')).toBe(true);
  });
  it('does not fire on negated phrasings', () => {
    expect(run('This release has no breaking changes.')).toBe(false);
    expect(run('A safe, non-breaking update.')).toBe(false);
    expect(run('Bug fixes and docs only.')).toBe(false);
  });
});

describe('detectSignals — deprecation', () => {
  it('fires on registry deprecated flag or text', () => {
    const pkg: Packument = { name: 'p', versions: { '2.0.0': { version: '2.0.0', deprecated: 'use q instead' } } };
    expect(detectSignals({ packument: pkg, locked: '1.0.0', latest: '2.0.0', advisories: [], texts: noTexts }).signals.deprecation).toBe(true);
    expect(detectSignals({ packument: null, locked: '1.0.0', latest: '2.0.0', advisories: [], texts: text('This API is deprecated.') }).signals.deprecation).toBe(true);
  });
});

describe('detectSignals — peer / node diff', () => {
  const pkg: Packument = {
    name: 'p',
    versions: {
      '1.0.0': { version: '1.0.0', peerDependencies: { react: '^17.0.0' }, engines: { node: '>=14' } },
      '2.0.0': { version: '2.0.0', peerDependencies: { react: '^18.0.0' }, engines: { node: '>=18' } },
    },
  };

  it('detects changed peerDependencies and engines.node', () => {
    const r = detectSignals({ packument: pkg, locked: '1.0.0', latest: '2.0.0', advisories: [], texts: noTexts });
    expect(r.signals.peer_dependency_changed).toBe(true);
    expect(r.signals.node_requirement_changed).toBe(true);
  });

  it('reports no change when metadata matches', () => {
    const same: Packument = {
      name: 'p',
      versions: {
        '1.0.0': { version: '1.0.0', peerDependencies: { react: '^18.0.0' }, engines: { node: '>=18' } },
        '2.0.0': { version: '2.0.0', peerDependencies: { react: '^18.0.0' }, engines: { node: '>=18' } },
      },
    };
    const r = detectSignals({ packument: same, locked: '1.0.0', latest: '2.0.0', advisories: [], texts: noTexts });
    expect(r.signals.peer_dependency_changed).toBe(false);
    expect(r.signals.node_requirement_changed).toBe(false);
  });

  it('notes (does not silently report false) when the locked version is absent', () => {
    const r = detectSignals({ packument: pkg, locked: '0.9.0', latest: '2.0.0', advisories: [], texts: noTexts });
    expect(r.signals.peer_dependency_changed).toBe(false);
    expect(r.notes.join(' ')).toMatch(/locked version 0\.9\.0 absent/);
  });

  it('notes when the latest version is absent from the registry', () => {
    const r = detectSignals({ packument: pkg, locked: '1.0.0', latest: '9.9.9', advisories: [], texts: noTexts });
    expect(r.notes.join(' ')).toMatch(/latest version 9\.9\.9 absent/);
  });

  it('detects a deprecation on the locked version only', () => {
    const lockedDeprecated: Packument = {
      name: 'p',
      versions: {
        '1.0.0': { version: '1.0.0', deprecated: 'no longer maintained' },
        '2.0.0': { version: '2.0.0' },
      },
    };
    const r = detectSignals({ packument: lockedDeprecated, locked: '1.0.0', latest: '2.0.0', advisories: [], texts: noTexts });
    expect(r.signals.deprecation).toBe(true);
  });
});
