/**
 * Types for the Code Relevance layer (M6, PLAN §7). A local grep verifies whether
 * the APIs the AI extracted (mentioned_apis) are actually used in the repo. Only
 * COUNTS are produced — never file paths or content (PLAN §14). The counts feed
 * the rule engine; nothing is sent to the AI.
 */

export interface ApiUsage {
  api: string;
  match_count: number;
  file_count: number;
}

export interface Relevance {
  /** A scan actually ran and produced usable counts. */
  scanned: boolean;
  /** Number of VALID API names actually searched (after validation/cap). */
  mentioned: number;
  /** True if the valid-API list was truncated — a partial scan can't prove irrelevance. */
  capped: boolean;
  /** Per-API counts, sorted by api. */
  apis: ApiUsage[];
  /** Sum of match_count across all searched APIs. */
  total_matches: number;
}

export function emptyRelevance(): Relevance {
  return { scanned: false, mentioned: 0, capped: false, apis: [], total_matches: 0 };
}
