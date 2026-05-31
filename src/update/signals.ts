import { type Advisory, type Signals, emptySignals } from '../types/update.js';
import type { VersionText } from './changelog.js';
import { type Packument, type PackumentVersion, versionMeta } from './npm-registry.js';

export interface SignalInput {
  packument: Packument | null;
  locked: string | null;
  latest: string | null;
  advisories: Advisory[];
  /** Release-note bodies for the (locked, latest] range. */
  texts: VersionText[];
}

export interface SignalResult {
  signals: Signals;
  /** Explanatory notes (e.g. why a diff was skipped). */
  notes: string[];
}

const MAX_SCAN_CHARS = 20_000;

/**
 * Keyword + metadata-diff signal detection (no AI, PLAN §5). Suppresses obvious
 * false positives ("no breaking changes") and never silently reports false when
 * the locked version's metadata is missing — it notes the gap instead (codex).
 */
export function detectSignals(input: SignalInput): SignalResult {
  const notes: string[] = [];
  const signals = emptySignals();

  signals.security = input.advisories.length > 0;

  const blob = input.texts.map((t) => t.text.slice(0, MAX_SCAN_CHARS)).join('\n\n');
  signals.breaking = hasBreaking(blob);

  const lockedMeta = input.packument && input.locked ? versionMeta(input.packument, input.locked) : undefined;
  const latestMeta = input.packument && input.latest ? versionMeta(input.packument, input.latest) : undefined;

  // Check both endpoints: current users are on `locked`, so a locked-only
  // deprecation still matters (codex).
  signals.deprecation = isDeprecated(lockedMeta) || isDeprecated(latestMeta) || /deprecat/i.test(blob);

  // peerDependencies / engines.node diff from registry metadata.
  if (!input.packument || !input.locked || !input.latest) {
    notes.push('peer/node diff skipped: missing packument or version');
  } else if (!lockedMeta) {
    notes.push(`peer/node diff skipped: locked version ${input.locked} absent from registry`);
  } else if (!latestMeta) {
    notes.push(`peer/node diff skipped: latest version ${input.latest} absent from registry`);
  } else {
    signals.peer_dependency_changed = depsChanged(lockedMeta.peerDependencies, latestMeta.peerDependencies);
    signals.node_requirement_changed = (lockedMeta.engines?.node ?? '') !== (latestMeta.engines?.node ?? '');
  }

  // browser_requirement_changed: no reliable registry signal in M2.
  return { signals, notes };
}

/** True if text announces a breaking change, after stripping negated phrasings. */
function hasBreaking(text: string): boolean {
  const cleaned = text
    .replace(/\bnon[- ]?breaking\b/gi, '')
    .replace(/\b(no|without|not|zero)\b[\s\w]{0,15}?breaking changes?/gi, '');
  if (/breaking[\s-]?changes?/i.test(cleaned) || /\bBREAKING\b/.test(cleaned)) return true;
  // Conventional-commit breaking marker: "feat!:", "fix(scope)!:".
  return /^\s*[a-z]+(\([^)]*\))?!:/im.test(text);
}

function isDeprecated(meta: PackumentVersion | undefined): boolean {
  return Boolean(meta?.deprecated);
}

function depsChanged(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const aKeys = Object.keys(a ?? {}).sort();
  const bKeys = Object.keys(b ?? {}).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return true;
  return aKeys.some((k) => a?.[k] !== b?.[k]);
}
