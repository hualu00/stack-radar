import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasUnreviewedMarkers, parseProfile } from '../src/scoring/profile.js';
import { draftProfileYaml } from '../src/scoring/profile-infer.js';

function repo(pkg: object, opts: { readme?: string; dirs?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-infer-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  if (opts.readme !== undefined) writeFileSync(join(dir, 'README.md'), opts.readme);
  for (const d of opts.dirs ?? []) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

describe('draftProfileYaml', () => {
  it('produces a profile that parses, with every field marked for review', () => {
    const yaml = draftProfileYaml(repo({ name: 'x', engines: { node: '>=20' } }));
    expect(() => parseProfile(yaml)).not.toThrow();
    expect(hasUnreviewedMarkers(yaml)).toBe(true);
    // all 11 profile fields carry a "# NEEDS REVIEW —" marker.
    expect((yaml.match(/NEEDS REVIEW —/g) ?? []).length).toBe(11);
  });

  it('clears the unreviewed warning once the field markers are deleted (header does not trip it)', () => {
    const yaml = draftProfileYaml(repo({ engines: { node: '>=20' } }));
    const cleared = yaml
      .split('\n')
      .map((l) => (l.includes('NEEDS REVIEW —') ? l.slice(0, l.indexOf('#')).trimEnd() : l))
      .join('\n');
    expect(hasUnreviewedMarkers(cleared)).toBe(false);
    expect(() => parseProfile(cleared)).not.toThrow(); // still a valid profile
  });

  it('carries engines.node into hard_constraints.node (or null when absent/malformed)', () => {
    expect(parseProfile(draftProfileYaml(repo({ engines: { node: '>=22' } }))).hard_constraints.node).toBe('>=22');
    expect(parseProfile(draftProfileYaml(repo({}))).hard_constraints.node).toBeNull();
    // a malformed engines.node must not make the self-validating draft throw
    expect(parseProfile(draftProfileYaml(repo({ engines: { node: 'node 22' } }))).hard_constraints.node).toBeNull();
  });

  it('guesses product_type from signals', () => {
    expect(parseProfile(draftProfileYaml(repo({ bin: { x: 'cli.js' } }))).product_type).toBe('internal_tool');
    expect(parseProfile(draftProfileYaml(repo({}, { dirs: ['packages'] }))).product_type).toBe('component_library');
    expect(parseProfile(draftProfileYaml(repo({}, { dirs: ['apps'] }))).product_type).toBe('business_app');
    expect(parseProfile(draftProfileYaml(repo({ description: 'Payments SDK' }))).product_type).toBe('sdk');
    expect(parseProfile(draftProfileYaml(repo({}))).product_type).toBe('business_app'); // safe default
  });

  it('is deterministic for a given repo state', () => {
    const r = repo({ name: 'x', engines: { node: '>=20' } }, { dirs: ['packages'] });
    expect(draftProfileYaml(r)).toBe(draftProfileYaml(r));
  });
});
