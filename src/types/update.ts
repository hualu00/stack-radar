/**
 * Types for `.stack-radar/updates.json` — output of the `check-updates` command.
 * Based on PLAN.md §5 (Module 2: Update Intelligence), with a few transparency
 * extensions (`instances`, `status`, `note`, `resolved_name`).
 */

import type { DependencyType } from './stack.js';

export type UpdateType = 'major' | 'minor' | 'patch' | 'prerelease' | 'none' | 'unknown';

/** Where the changelog/release note came from, in descending reliability. */
export type ReleaseNoteSource = 'github_release' | 'github_tag' | 'changelog_md' | 'commits';

export type Confidence = 'high' | 'medium' | 'low';

/** Outcome of processing a package. `partial` = some data source was unavailable
 * (e.g. advisory lookup failed), so a clean-looking record may be incomplete. */
export type UpdateStatus = 'ok' | 'partial' | 'skipped_private' | 'not_found' | 'error';

/** A site (workspace + block) where a given (name, locked_version) appears. */
export interface Instance {
  workspace: string;
  current_range: string;
  dependency_type: DependencyType;
}

export interface ReleaseNote {
  version: string;
  url: string;
  source: ReleaseNoteSource;
  confidence: Confidence;
  /**
   * Truncated release-note body, persisted so the AI evidence layer (M5) has a
   * self-contained input in updates.json. Absent in pre-M5 files and when the
   * source had no body text. Signal detection still scans the full (untruncated)
   * body during `check-updates`; only this persisted copy is capped.
   */
  text?: string;
  /** True when `text` was cut from a longer body. */
  text_truncated?: boolean;
}

export interface Advisory {
  id: string;
  source: 'osv' | 'github';
  severity?: string;
  summary?: string;
  url?: string;
  affected_range?: string;
}

export interface Signals {
  security: boolean;
  breaking: boolean;
  deprecation: boolean;
  peer_dependency_changed: boolean;
  node_requirement_changed: boolean;
  browser_requirement_changed: boolean;
}

/** The latest version's requirements, used by scoring to decide Blocked. */
export interface Requirements {
  /** engines.node of the latest version, or null. */
  node: string | null;
  /** peerDependencies of the latest version (keys sorted for deterministic output). */
  peers: Record<string, string>;
  /** Peer names marked optional via peerDependenciesMeta. */
  optional_peers: string[];
}

/** One record per unique (name, locked_version). */
export interface UpdateRecord {
  name: string;
  /** Real package name when `name` is an alias (`npm:real-pkg@…`); else absent. */
  resolved_name?: string;
  /** All (workspace, current_range) sites that share this (name, locked_version). */
  instances: Instance[];
  locked_version: string | null;
  latest_version: string | null;
  update_type: UpdateType;
  release_notes: ReleaseNote[];
  advisories: Advisory[];
  signals: Signals;
  /** Latest version's node/peer requirements (for Blocked scoring). */
  requirements: Requirements;
  status: UpdateStatus;
  /** Human-readable reason for non-ok status or partial data. */
  note?: string;
}

/**
 * Run-local identity for a record, unique per (name, resolved_name, locked_version).
 * Includes `resolved_name` so two aliases sharing a declared name + locked version
 * never collide — which would cross-attach AI evidence or a feedback decision to the
 * wrong sibling (M7). Internal map key only; never rendered.
 */
export function recordKey(r: Pick<UpdateRecord, 'name' | 'resolved_name' | 'locked_version'>): string {
  return `${r.name}@@${r.resolved_name ?? ''}@@${r.locked_version ?? ''}`;
}

export function emptyRequirements(): Requirements {
  return { node: null, peers: {}, optional_peers: [] };
}

export function emptySignals(): Signals {
  return {
    security: false,
    breaking: false,
    deprecation: false,
    peer_dependency_changed: false,
    node_requirement_changed: false,
    browser_requirement_changed: false,
  };
}
