import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInitProfile } from '../src/commands/init-profile.js';
import { parseProfile } from '../src/scoring/profile.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-init-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', engines: { node: '>=20' } }));
  return dir;
}

describe('runInitProfile', () => {
  it('writes a self-valid draft profile marked for review', () => {
    const dir = repo();
    runInitProfile({ repo: dir });
    const text = readFileSync(join(dir, '.stack-radar', 'project-profile.yaml'), 'utf8');
    expect(text).toMatch(/NEEDS REVIEW/);
    expect(() => parseProfile(text)).not.toThrow();
  });

  it('refuses to overwrite an existing profile without --force', () => {
    const dir = repo();
    runInitProfile({ repo: dir });
    expect(() => runInitProfile({ repo: dir })).toThrow(/already exists/);
  });

  it('overwrites with --force', () => {
    const dir = repo();
    runInitProfile({ repo: dir });
    expect(() => runInitProfile({ repo: dir, force: true })).not.toThrow();
    expect(existsSync(join(dir, '.stack-radar', 'project-profile.yaml'))).toBe(true);
  });
});
