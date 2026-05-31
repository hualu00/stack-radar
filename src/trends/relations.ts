/**
 * Local-only canonicalization + stack-relation matching for the Trend Watcher
 * (M9). Pure and deterministic. NOTHING here is sent to the AI — relating a
 * trending tool to the project's stack happens entirely on local data, so the
 * privacy boundary (PLAN §14) holds: the AI only ever saw public feed text.
 */

/**
 * Variant spellings → a single canonical tool key. Keys are normalized
 * (lowercased, whitespace-collapsed). Small + hand-curated for v1; extend freely.
 */
const ALIASES = new Map<string, string>([
  ['react query', 'tanstack-react-query'],
  ['tanstack query', 'tanstack-react-query'],
  ['react-query', 'tanstack-react-query'],
  ['@tanstack/react-query', 'tanstack-react-query'],
  ['tanstack router', 'tanstack-router'],
  ['@tanstack/react-router', 'tanstack-router'],
  ['vitejs', 'vite'],
  ['rolldown-vite', 'vite'],
  ['biomejs', 'biome'],
  ['biome.js', 'biome'],
  ['@biomejs/biome', 'biome'],
  ['nextjs', 'next'],
  ['next.js', 'next'],
  ['node.js', 'node'],
  ['nodejs', 'node'],
]);

/**
 * Trending tool key → stack tool keys it could SUBSTITUTE or COMPLEMENT. Used to
 * decide whether a trend is relevant to THIS project. Keyed/valued by canonical
 * tool keys (so stack package names are canonicalized before lookup).
 */
const SUBSTITUTES = new Map<string, string[]>([
  ['biome', ['eslint', 'prettier']],
  ['vite', ['webpack', 'rspack', 'parcel', 'esbuild']],
  ['rspack', ['webpack']],
  ['turbopack', ['webpack']],
  ['rolldown', ['rollup', 'esbuild']],
  ['bun', ['node', 'npm', 'pnpm', 'yarn']],
  ['deno', ['node']],
  ['vitest', ['jest']],
  ['oxlint', ['eslint']],
  ['oxc', ['eslint', 'babel']],
  ['tanstack-router', ['react-router']],
  ['tanstack-start', ['next']],
]);

/** Canonical, stable key for a tool from its display name and optional package hint. */
export function canonicalToolKey(displayName: string, canonicalHint?: string): string {
  const basis = canonicalHint && canonicalHint.trim() !== '' ? canonicalHint : displayName;
  const normalized = basis.toLowerCase().replace(/\s+/g, ' ').trim();
  return ALIASES.get(normalized) ?? slug(normalized);
}

/**
 * Stack item names (original casing) this tool substitutes or complements — i.e.
 * why the trend matters to this project. Returns sorted, de-duplicated names;
 * empty means no relation (the trend stays "Emerging", never a Signal).
 */
export function relateToStack(toolKey: string, stackNames: readonly string[]): string[] {
  const byKey = new Map<string, string>(); // canonical key -> original stack name
  for (const name of stackNames) {
    const key = canonicalToolKey(name);
    if (!byKey.has(key)) byKey.set(key, name);
  }

  const related = new Set<string>();
  // The trending tool IS in the stack → news about your own dependency is relevant.
  const inStack = byKey.get(toolKey);
  if (inStack !== undefined) related.add(inStack);
  // The trending tool could replace/complement something you depend on.
  for (const competitorKey of SUBSTITUTES.get(toolKey) ?? []) {
    const name = byKey.get(competitorKey);
    if (name !== undefined) related.add(name);
  }
  return [...related].sort((a, b) => a.localeCompare(b));
}

/** Slugify a normalized name: drop a leading scope `@`, turn `/` and spaces into `-`. */
function slug(normalized: string): string {
  return normalized
    .replace(/^@/, '')
    .replace(/[/\s]+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
