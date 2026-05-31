import { join, resolve } from 'node:path';
import { checkUpdates } from '../update/index.js';
import { writeJson } from '../utils/fs.js';

export interface CheckUpdatesCommandOptions {
  repo: string;
  refresh?: boolean;
}

/**
 * Run `check-updates`: read stack.json, fetch update intelligence, and write
 * `<repo>/.stack-radar/updates.json`. Read-only over the repo aside from that
 * single output file (+ the public-data cache under .stack-radar/cache/).
 */
export async function runCheckUpdates(options: CheckUpdatesCommandOptions): Promise<void> {
  const repoPath = resolve(options.repo);
  const records = await checkUpdates(repoPath, { refresh: options.refresh });

  const outPath = join(repoPath, '.stack-radar', 'updates.json');
  writeJson(outPath, records);

  const count = (status: string) => records.filter((r) => r.status === status).length;
  const withNotes = records.filter((r) => r.release_notes.length > 0).length;
  const withAdvisory = records.filter((r) => r.advisories.length > 0).length;

  console.log(`Checked ${records.length} packages`);
  console.log(
    `  ok: ${count('ok')}  |  partial: ${count('partial')}  |  private: ${count('skipped_private')}  |  not_found: ${count('not_found')}  |  error: ${count('error')}`,
  );
  console.log(`  release_notes: ${withNotes}/${records.length}  |  advisories: ${withAdvisory}`);
  const hasToken = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  console.log(`  github token: ${hasToken ? 'yes' : 'no'}`);
  if (!hasToken) {
    console.log('  note: no GITHUB_TOKEN — GitHub releases limited to 60 req/hr (degrades to CHANGELOG). Set GITHUB_TOKEN for full coverage.');
  }
  console.log(`  -> ${outPath}`);
}
