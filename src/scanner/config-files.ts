import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileExists } from '../utils/fs.js';

/** A tool's dedicated config files and the package(s) they configure. */
interface ConfigDef {
  /** Package names this config attaches to. */
  packages: string[];
  /** Candidate filenames (checked for existence, relative to the package dir). */
  files: string[];
}

const CONFIG_DEFS: ConfigDef[] = [
  { packages: ['vite'], files: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.mts'] },
  { packages: ['webpack'], files: ['webpack.config.js', 'webpack.config.ts', 'webpack.config.cjs', 'webpack.config.mjs'] },
  { packages: ['@rspack/core'], files: ['rspack.config.js', 'rspack.config.ts'] },
  { packages: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
  { packages: ['typescript'], files: ['tsconfig.json'] },
  {
    packages: ['eslint'],
    files: [
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
    ],
  },
  { packages: ['@biomejs/biome'], files: ['biome.json', 'biome.jsonc'] },
  { packages: ['prettier'], files: ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.yaml', '.prettierrc.yml', 'prettier.config.js', 'prettier.config.cjs'] },
  { packages: ['jest'], files: ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json'] },
  { packages: ['vitest'], files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs', 'vitest.workspace.ts'] },
  { packages: ['@playwright/test', 'playwright'], files: ['playwright.config.ts', 'playwright.config.js'] },
  { packages: ['turbo'], files: ['turbo.json'] },
  { packages: ['nx'], files: ['nx.json'] },
  { packages: ['lerna'], files: ['lerna.json'] },
];

/**
 * For a single package directory, map package name → present dedicated config
 * file names (relative to that dir). Used to populate `item.config_files`.
 */
export function detectConfigFiles(dir: string): Map<string, string[]> {
  const byPackage = new Map<string, string[]>();
  for (const def of CONFIG_DEFS) {
    const present = def.files.filter((f) => fileExists(join(dir, f)));
    if (present.length === 0) continue;
    for (const pkg of def.packages) {
      byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), ...present]);
    }
  }
  return byPackage;
}

/** Whether the repo has GitHub Actions workflows (PLAN §4 lists this as a CI data source). */
export function hasGithubActions(repoPath: string): boolean {
  const dir = join(repoPath, '.github', 'workflows');
  try {
    return readdirSync(dir).some((f) => /\.ya?ml$/.test(f));
  } catch {
    return false;
  }
}
