import { join, resolve } from 'node:path';
import { hasGithubActions } from '../scanner/config-files.js';
import { scanRepo } from '../scanner/index.js';
import { writeJson } from '../utils/fs.js';

export interface ScanOptions {
  /** Path to the repo to scan (resolved against cwd). */
  repo: string;
}

/**
 * Run the `scan` command: build the stack model and write
 * `<repo>/.stack-radar/stack.json`. Read-only over the target repo aside from
 * that single output file. Throws on fatal errors (e.g. missing package.json).
 */
export function runScan(options: ScanOptions): void {
  const repoPath = resolve(options.repo);
  const stack = scanRepo(repoPath);

  const outPath = join(repoPath, '.stack-radar', 'stack.json');
  writeJson(outPath, stack);

  const total = stack.items.length;
  const locked = stack.items.filter((i) => i.locked_version !== null).length;
  const tag = stack.repo.is_monorepo ? `${stack.repo.package_manager}, monorepo` : stack.repo.package_manager;

  console.log(`Scanned ${stack.repo.name} (${tag})`);
  console.log(`  items: ${total}  |  locked: ${locked}/${total}  |  CI: ${hasGithubActions(repoPath) ? 'yes' : 'no'}`);
  if (stack.repo.is_monorepo) {
    const dirs = new Set(stack.items.map((i) => i.workspace));
    console.log(`  workspaces: ${stack.repo.workspaces.join(', ') || '(none)'}  |  package dirs with deps: ${dirs.size}`);
  }
  console.log(`  -> ${outPath}`);
}
