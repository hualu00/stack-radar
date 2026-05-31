import { join, resolve } from 'node:path';
import { draftProfileYaml } from '../scoring/profile-infer.js';
import { parseProfile } from '../scoring/profile.js';
import { fileExists, writeText } from '../utils/fs.js';

export interface InitProfileOptions {
  repo: string;
  /** Overwrite an existing profile instead of refusing. */
  force?: boolean;
}

/**
 * Draft `.stack-radar/project-profile.yaml` from the repo (PLAN §7). Refuses to
 * clobber an existing profile unless `--force`. The draft is self-validated, but
 * every field is marked `# NEEDS REVIEW` — the human must confirm it before it
 * is trusted.
 */
export function runInitProfile(options: InitProfileOptions): void {
  const repoPath = resolve(options.repo);
  const outPath = join(repoPath, '.stack-radar', 'project-profile.yaml');
  if (fileExists(outPath) && !options.force) {
    throw new Error(`${outPath} already exists — pass --force to overwrite it.`);
  }

  const yaml = draftProfileYaml(repoPath);
  parseProfile(yaml); // self-check: the draft must be a valid profile (throws otherwise)
  writeText(outPath, yaml);

  console.log(`Wrote draft profile -> ${outPath}`);
  console.log('Next: open it, correct every field, and delete the "# NEEDS REVIEW" markers.');
  console.log('A wrong profile skews all recommendations, so this first review is required.');
}
