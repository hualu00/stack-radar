import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectConfigFiles, hasGithubActions } from '../src/scanner/config-files.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const configsDir = join(FIXTURES, 'configs');

describe('detectConfigFiles', () => {
  const byPackage = detectConfigFiles(configsDir);

  it('maps present config files to their packages', () => {
    expect(byPackage.get('typescript')).toEqual(['tsconfig.json']);
    expect(byPackage.get('vite')).toEqual(['vite.config.ts']);
    expect(byPackage.get('@biomejs/biome')).toEqual(['biome.json']);
  });

  it('omits packages whose config files are absent', () => {
    expect(byPackage.has('webpack')).toBe(false);
    expect(byPackage.has('jest')).toBe(false);
  });
});

describe('hasGithubActions', () => {
  it('is true when a workflow yml exists', () => {
    expect(hasGithubActions(configsDir)).toBe(true);
  });
  it('is false when there are no workflows', () => {
    expect(hasGithubActions(join(FIXTURES, 'npm-simple'))).toBe(false);
  });
});
