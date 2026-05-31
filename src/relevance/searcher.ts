import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { globSync } from 'tinyglobby';
import { type ApiUsage, type Relevance, emptyRelevance } from '../types/relevance.js';

/** Max APIs searched per call; beyond this the scan is "capped" and can't prove irrelevance. */
export const MAX_APIS = 12;

/** Only plain JS identifiers are searchable, so ripgrep `-w` and the Node `\b` fallback
 * behave identically. `$`/dotted/member APIs are skipped (documented M6 limitation). */
const API_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const INCLUDE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];
// Explicit excludes (do NOT rely on .gitignore) — both searchers use the same policy.
const EXCLUDE_DIRS = ['node_modules', 'dist', 'build', 'out', '.git', '.stack-radar', 'coverage', '.next', '.cache'];

/** Validate, dedupe, sort, and cap the requested API names. */
export function normalizeApis(apis: string[]): { apis: string[]; capped: boolean } {
  // Trim first — Step 3 passes raw AI `mentioned_apis`, which may carry whitespace.
  const valid = [...new Set(apis.map((a) => a.trim()).filter((a) => a.length >= 2 && API_RE.test(a)))].sort();
  return { apis: valid.slice(0, MAX_APIS), capped: valid.length > MAX_APIS };
}

/** Injectable subprocess seam — unit tests fake ripgrep's stdout/exit code. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const execFileRunner: CommandRunner = (file, args) =>
  new Promise((resolvePromise) => {
    execFile(file, args, { shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      const rawCode = (err as { code?: number | string } | null)?.code;
      // Numeric code = process exit status; a string code (e.g. ENOENT) = spawn failure → -1.
      const code = typeof rawCode === 'number' ? rawCode : err ? -1 : 0;
      resolvePromise({ stdout: stdout ?? '', code });
    });
  });

export interface ApiSearcher {
  search(repoPath: string, apis: string[]): Promise<Relevance>;
}

export interface ApiSearcherOptions {
  /** Force ripgrep on/off; default = auto-detect once. */
  ripgrep?: boolean;
  /** Injected runner (tests); default = execFile. */
  runner?: CommandRunner;
}

/**
 * Build an API-usage searcher: ripgrep when available, else a pure-Node fallback
 * (same include/exclude policy + word-boundary rule, so counts match). Only counts
 * leave this module — paths from rg stdout are parsed off and discarded. A failed
 * scan returns `scanned:false` so the rule engine never concludes irrelevance.
 */
export function createApiSearcher(options: ApiSearcherOptions = {}): ApiSearcher {
  const runner = options.runner ?? execFileRunner;
  const usageCache = new Map<string, ApiUsage>(); // key: `<api> <repoPath>` (api has no spaces)
  const fileCache = new Map<string, string[]>(); // repoPath -> file list (fallback)
  let ripgrepResolved: Promise<boolean> | undefined;

  const hasRipgrep = (): Promise<boolean> => {
    if (options.ripgrep !== undefined) return Promise.resolve(options.ripgrep);
    ripgrepResolved ??= runner('rg', ['--version']).then((r) => r.code === 0).catch(() => false);
    return ripgrepResolved;
  };

  const listFiles = (repoPath: string): string[] => {
    let files = fileCache.get(repoPath);
    if (!files) {
      files = globSync([`**/{${INCLUDE_GLOBS.join(',')}}`], {
        cwd: repoPath,
        absolute: true,
        dot: false,
        followSymbolicLinks: false,
        ignore: EXCLUDE_DIRS.map((d) => `**/${d}/**`),
      });
      fileCache.set(repoPath, files);
    }
    return files;
  };

  const countWithRipgrep = async (repoPath: string, api: string): Promise<ApiUsage> => {
    const args = [
      '--count-matches',
      '--fixed-strings',
      '--word-regexp',
      '--no-follow',
      '--no-ignore', // rely on explicit globs, not .gitignore
      ...INCLUDE_GLOBS.flatMap((g) => ['-g', g]),
      ...EXCLUDE_DIRS.flatMap((d) => ['-g', `!**/${d}/**`]),
      '--',
      api,
      repoPath,
    ];
    const { stdout, code } = await runner('rg', args);
    if (code === 1) return { api, match_count: 0, file_count: 0 }; // no matches
    if (code !== 0) throw new Error(`ripgrep exited ${code}`);
    let match = 0;
    let files = 0;
    for (const line of stdout.split('\n')) {
      if (line === '') continue;
      const n = Number(line.slice(line.lastIndexOf(':') + 1)); // count after the LAST ':'; path discarded
      if (Number.isFinite(n) && n > 0) {
        match += n;
        files += 1;
      }
    }
    return { api, match_count: match, file_count: files };
  };

  const countWithNode = (repoPath: string, apis: string[]): ApiUsage[] => {
    const acc = new Map(apis.map((a) => [a, { match: 0, files: 0 }]));
    const res = new Map(apis.map((a) => [a, new RegExp(`\\b${a}\\b`, 'g')]));
    for (const file of listFiles(repoPath)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const api of apis) {
        const re = res.get(api);
        const acc1 = acc.get(api);
        if (!re || !acc1) continue;
        re.lastIndex = 0;
        const m = text.match(re);
        if (m && m.length > 0) {
          acc1.match += m.length;
          acc1.files += 1;
        }
      }
    }
    return apis.map((api) => ({ api, match_count: acc.get(api)?.match ?? 0, file_count: acc.get(api)?.files ?? 0 }));
  };

  const key = (repoPath: string, api: string): string => `${api} ${repoPath}`;

  const countAll = async (repoPath: string, apis: string[]): Promise<ApiUsage[]> => {
    const missing = apis.filter((a) => !usageCache.has(key(repoPath, a)));
    if (missing.length > 0) {
      const computed = (await hasRipgrep())
        ? await Promise.all(missing.map((a) => countWithRipgrep(repoPath, a)))
        : countWithNode(repoPath, missing);
      for (const u of computed) usageCache.set(key(repoPath, u.api), u);
    }
    return apis.map((a) => usageCache.get(key(repoPath, a)) ?? { api: a, match_count: 0, file_count: 0 });
  };

  return {
    async search(repoPath: string, apis: string[]): Promise<Relevance> {
      const { apis: valid, capped } = normalizeApis(apis);
      if (valid.length === 0) return { scanned: true, mentioned: 0, capped, apis: [], total_matches: 0 };
      try {
        const usages = await countAll(repoPath, valid);
        const total = usages.reduce((sum, u) => sum + u.match_count, 0);
        return { scanned: true, mentioned: valid.length, capped, apis: usages, total_matches: total };
      } catch {
        return emptyRelevance(); // scan failed → no usable relevance, never concludes irrelevance
      }
    },
  };
}
