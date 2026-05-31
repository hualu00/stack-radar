import { resolve } from 'node:path';
import { type ApiSearcher, MAX_APIS, createApiSearcher } from '../relevance/searcher.js';

export interface ScanApiUsageOptions {
  repo: string;
  /** Comma-separated API identifiers. */
  apis: string;
  /** Package the APIs belong to — label only. */
  package?: string;
  /** Injected in tests. */
  searcher?: ApiSearcher;
}

/**
 * Count local usage of the given API identifiers (PLAN §7 Code Relevance). Prints
 * COUNTS only — never file paths or content (PLAN §14). Standalone debug command
 * and the engine `recommend --use-ai` reuses.
 */
export async function runScanApiUsage(options: ScanApiUsageOptions): Promise<void> {
  const repoPath = resolve(options.repo);
  const apis = options.apis
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const searcher = options.searcher ?? createApiSearcher();
  const relevance = await searcher.search(repoPath, apis);

  // Deliberately do NOT print repoPath — keep the output paths-free (PLAN §14).
  const scope = options.package ? ` for ${options.package}` : '';
  console.log(`API usage${scope}:`);
  if (!relevance.scanned) {
    console.log('  (scan unavailable)');
    return;
  }
  if (relevance.apis.length === 0) {
    console.log('  (no valid API identifiers to search)');
    return;
  }
  for (const u of relevance.apis) {
    console.log(`  ${u.api}: ${u.match_count} matches across ${u.file_count} files`);
  }
  console.log(`  total: ${relevance.total_matches} matches across ${relevance.mentioned} APIs`);
  if (relevance.capped) console.log(`  (note: API list capped at ${MAX_APIS}; counts are partial)`);
}
