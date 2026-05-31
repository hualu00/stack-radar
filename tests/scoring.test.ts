import { describe, expect, it } from 'vitest';
import type { Relevance } from '../src/types/relevance.js';
import type { ProjectContext } from '../src/types/score.js';
import type { StackJson } from '../src/types/stack.js';
import { type UpdateRecord, emptyRequirements, emptySignals } from '../src/types/update.js';
import { type BlockedResult, evaluateBlocked } from '../src/scoring/blocked.js';
import { scoreConfidence, scoreRisk, scoreUrgency, scoreValue } from '../src/scoring/dimensions.js';
import { buildProjectContext, scoreRecord } from '../src/scoring/index.js';
import { decideRecommendation } from '../src/scoring/recommend.js';

function rec(over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    name: 'pkg',
    instances: [{ workspace: '.', current_range: '^1', dependency_type: 'dependencies' }],
    locked_version: '1.0.0',
    latest_version: '1.1.0',
    update_type: 'minor',
    release_notes: [],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status: 'ok',
    ...over,
  };
}

function ctx(nodeEngine: string | null, locked: Record<string, Record<string, string>> = {}): ProjectContext {
  const m = new Map<string, Map<string, string>>();
  for (const [ws, names] of Object.entries(locked)) m.set(ws, new Map(Object.entries(names)));
  return { nodeEngine, lockedByWorkspace: m };
}

const noBlock: BlockedResult = { blocked: false, reasons: [], caveats: [], missingPeers: [] };

describe('evaluateBlocked — node', () => {
  it('blocks when the project Node range is not a subset of the requirement', () => {
    const r = evaluateBlocked({ node: '>=20', peers: {}, optional_peers: [] }, ['.'], ctx('>=18'));
    expect(r.blocked).toBe(true);
    expect(r.reasons[0]).toMatch(/Node/);
  });
  it('does not block when the project Node satisfies the requirement', () => {
    expect(evaluateBlocked({ node: '>=18', peers: {}, optional_peers: [] }, ['.'], ctx('>=20')).blocked).toBe(false);
  });
  it('caveats (no block) when project Node engine is unknown, `*`, or unparseable', () => {
    expect(evaluateBlocked({ node: '>=20', peers: {}, optional_peers: [] }, ['.'], ctx(null)).blocked).toBe(false);
    expect(evaluateBlocked({ node: '*', peers: {}, optional_peers: [] }, ['.'], ctx('>=18')).caveats).toHaveLength(0);
    expect(evaluateBlocked({ node: 'garbage', peers: {}, optional_peers: [] }, ['.'], ctx('>=18')).blocked).toBe(false);
    // a wildcard PROJECT node engine must not block (can't confirm) — caveat only
    const wild = evaluateBlocked({ node: '>=20', peers: {}, optional_peers: [] }, ['.'], ctx('*'));
    expect(wild.blocked).toBe(false);
    expect(wild.caveats.length).toBeGreaterThan(0);
  });
});

describe('evaluateBlocked — peers', () => {
  it('blocks when a locked peer does not satisfy the required range', () => {
    const r = evaluateBlocked({ node: null, peers: { react: '^19' }, optional_peers: [] }, ['.'], ctx(null, { '.': { react: '18.2.0' } }));
    expect(r.blocked).toBe(true);
  });
  it('does not block when the locked peer satisfies', () => {
    expect(evaluateBlocked({ node: null, peers: { react: '^18' }, optional_peers: [] }, ['.'], ctx(null, { '.': { react: '18.2.0' } })).blocked).toBe(false);
  });
  it('treats a missing required peer as missingPeers (not blocked)', () => {
    const r = evaluateBlocked({ node: null, peers: { react: '^19' }, optional_peers: [] }, ['.'], ctx(null));
    expect(r.blocked).toBe(false);
    expect(r.missingPeers).toEqual(['react']);
  });
  it('ignores an optional missing peer', () => {
    const r = evaluateBlocked({ node: null, peers: { react: '^19' }, optional_peers: ['react'] }, ['.'], ctx(null));
    expect(r.blocked).toBe(false);
    expect(r.missingPeers).toEqual([]);
  });
  it('blocks if ANY relevant workspace has a failing locked peer (monorepo)', () => {
    const context = ctx(null, { 'packages/a': { react: '19.0.0' }, 'packages/b': { react: '17.0.0' } });
    expect(evaluateBlocked({ node: null, peers: { react: '^19' }, optional_peers: [] }, ['packages/a', 'packages/b'], context).blocked).toBe(true);
    // but only workspace a is relevant -> not blocked
    expect(evaluateBlocked({ node: null, peers: { react: '^19' }, optional_peers: [] }, ['packages/a'], context).blocked).toBe(false);
  });
  it('resolves peers local-first: a satisfying local peer wins over an older root', () => {
    // root has react 17, but workspace a has its own react 19 -> not blocked
    const context = ctx(null, { '.': { react: '17.0.0' }, 'packages/a': { react: '19.0.0' } });
    expect(evaluateBlocked({ node: null, peers: { react: '^19' }, optional_peers: [] }, ['packages/a'], context).blocked).toBe(false);
    // workspace b has no local react -> falls back to root 17 -> blocked
    expect(evaluateBlocked({ node: null, peers: { react: '^19' }, optional_peers: [] }, ['packages/b'], context).blocked).toBe(true);
  });
});

describe('dimensions', () => {
  it('urgency: security > deprecation > baseline', () => {
    expect(scoreUrgency(rec({ signals: { ...emptySignals(), security: true } }))).toBe('high');
    expect(scoreUrgency(rec({ signals: { ...emptySignals(), deprecation: true } }))).toBe('medium');
    expect(scoreUrgency(rec())).toBe('low');
  });
  it('risk: high for major/breaking/prerelease/blocked; medium for changed-but-satisfied', () => {
    expect(scoreRisk(rec({ update_type: 'major' }), noBlock)).toBe('high');
    expect(scoreRisk(rec({ signals: { ...emptySignals(), breaking: true } }), noBlock)).toBe('high');
    expect(scoreRisk(rec({ update_type: 'prerelease' }), noBlock)).toBe('high');
    expect(scoreRisk(rec(), { ...noBlock, blocked: true })).toBe('high');
    expect(scoreRisk(rec({ signals: { ...emptySignals(), peer_dependency_changed: true } }), noBlock)).toBe('medium');
    expect(scoreRisk(rec(), { ...noBlock, missingPeers: ['react'] })).toBe('medium');
    expect(scoreRisk(rec({ update_type: 'patch' }), noBlock)).toBe('low');
  });
  it('value: security high; notes -> medium; no notes -> low (keeps Defer reachable)', () => {
    expect(scoreValue(rec({ signals: { ...emptySignals(), security: true } }))).toBe('high');
    expect(scoreValue(rec({ update_type: 'major', release_notes: [{ version: '2.0.0', url: 'u', source: 'github_release', confidence: 'high' }] }))).toBe('medium');
    expect(scoreValue(rec({ update_type: 'major' }))).toBe('low'); // no notes
    expect(scoreValue(rec({ update_type: 'minor' }))).toBe('low');
  });
  it('confidence: status gate first, then release-note source, advisory floors to medium', () => {
    expect(scoreConfidence(rec({ status: 'partial' }))).toBe('low');
    expect(scoreConfidence(rec({ status: 'not_found' }))).toBe('low');
    expect(scoreConfidence(rec({ release_notes: [{ version: '1.1.0', url: 'u', source: 'github_release', confidence: 'high' }] }))).toBe('high');
    expect(scoreConfidence(rec({ release_notes: [{ version: '1.1.0', url: 'u', source: 'changelog_md', confidence: 'medium' }] }))).toBe('medium');
    expect(scoreConfidence(rec())).toBe('low');
    expect(scoreConfidence(rec({ advisories: [{ id: 'GHSA-x', source: 'osv' }] }))).toBe('medium');
  });
});

describe('decideRecommendation', () => {
  const sec = { ...emptySignals(), security: true };
  it('blocked -> Blocked', () => {
    expect(decideRecommendation({ record: rec(), blocked: { ...noBlock, blocked: true }, risk: 'high', value: 'low' })).toBe('Blocked');
  });
  it('security: low-risk -> Upgrade Now, high-risk -> Review First', () => {
    expect(decideRecommendation({ record: rec({ signals: sec }), blocked: noBlock, risk: 'low', value: 'high' })).toBe('Upgrade Now');
    expect(decideRecommendation({ record: rec({ signals: sec, update_type: 'major' }), blocked: noBlock, risk: 'high', value: 'high' })).toBe('Review First');
  });
  it('prerelease -> Watch', () => {
    expect(decideRecommendation({ record: rec({ update_type: 'prerelease' }), blocked: noBlock, risk: 'high', value: 'low' })).toBe('Watch');
  });
  it('high-risk major: no benefit evidence -> Defer; with notes -> Review First', () => {
    expect(decideRecommendation({ record: rec({ update_type: 'major' }), blocked: noBlock, risk: 'high', value: 'low' })).toBe('Defer');
    expect(decideRecommendation({ record: rec({ update_type: 'major', release_notes: [{ version: '2.0.0', url: 'u', source: 'github_release', confidence: 'high' }] }), blocked: noBlock, risk: 'high', value: 'medium' })).toBe('Review First');
  });
  it('deprecation -> Review First; clean patch/minor -> Safe to Upgrade', () => {
    expect(decideRecommendation({ record: rec({ signals: { ...emptySignals(), deprecation: true } }), blocked: noBlock, risk: 'medium', value: 'low' })).toBe('Review First');
    expect(decideRecommendation({ record: rec({ update_type: 'patch' }), blocked: noBlock, risk: 'low', value: 'low' })).toBe('Safe to Upgrade');
  });
});

describe('scoreRecord + buildProjectContext', () => {
  it('scores a security minor as Upgrade Now with urgency high', () => {
    const r = scoreRecord(rec({ signals: { ...emptySignals(), security: true }, advisories: [{ id: 'GHSA-x', source: 'osv' }] }), ctx(null));
    expect(r.recommendation).toBe('Upgrade Now');
    expect(r.urgency).toBe('high');
    expect(r.reasons.some((x) => /Security advisory/.test(x))).toBe(true);
  });
  it('reaches Defer for a high-risk major with no release notes', () => {
    const r = scoreRecord(rec({ update_type: 'major', latest_version: '2.0.0' }), ctx(null));
    expect(r.recommendation).toBe('Defer');
  });
  it('flags advisory-only evidence even when advisory floors confidence to medium', () => {
    const r = scoreRecord(rec({ signals: { ...emptySignals(), security: true }, advisories: [{ id: 'GHSA-x', source: 'osv' }], release_notes: [] }), ctx(null));
    expect(r.confidence).toBe('medium');
    expect(r.caveats.some((c) => /advisory only/.test(c))).toBe(true);
  });
  it('builds per-workspace locked maps from stack.json', () => {
    const stack = {
      schema_version: '1.0',
      repo: { name: 'r', package_manager: 'npm', is_monorepo: true, workspaces: [] },
      runtime: { node_engine: '>=20', typescript_version: null },
      items: [
        { name: 'react', workspace: 'packages/a', locked_version: '18.2.0', current_range: '^18', category: 'framework', dependency_type: 'dependencies', is_direct_dependency: true, config_files: [] },
        { name: 'react', workspace: 'packages/b', locked_version: '17.0.2', current_range: '^17', category: 'framework', dependency_type: 'dependencies', is_direct_dependency: true, config_files: [] },
      ],
    } as unknown as StackJson;
    const c = buildProjectContext(stack);
    expect(c.nodeEngine).toBe('>=20');
    expect(c.lockedByWorkspace.get('packages/a')?.get('react')).toBe('18.2.0');
    expect(c.lockedByWorkspace.get('packages/b')?.get('react')).toBe('17.0.2');
  });
});

const noteHigh = { version: '2', url: 'u', source: 'github_release' as const, confidence: 'high' as const };
function rel(over: Partial<Relevance> = {}): Relevance {
  return { scanned: true, mentioned: 2, capped: false, apis: [], total_matches: 5, ...over };
}

describe('scoreValue — code relevance (M6)', () => {
  it('falls back to the base heuristic when no scan ran', () => {
    expect(scoreValue(rec({ release_notes: [] }))).toBe('low');
    expect(scoreValue(rec({ release_notes: [noteHigh] }))).toBe('medium');
  });
  it('any usage → medium, zero usage → none', () => {
    expect(scoreValue(rec(), rel({ total_matches: 5 }))).toBe('medium');
    expect(scoreValue(rec(), rel({ total_matches: 0 }))).toBe('none');
  });
  it('security still wins over relevance', () => {
    expect(scoreValue(rec({ signals: { ...emptySignals(), security: true } }), rel({ total_matches: 0 }))).toBe('high');
  });
  it('mentioned=0 (no valid APIs) falls back to the heuristic', () => {
    expect(scoreValue(rec({ release_notes: [noteHigh] }), rel({ mentioned: 0, total_matches: 0 }))).toBe('medium');
  });
  it('a capped (partial) zero-match scan is too weak to claim none → heuristic', () => {
    expect(scoreValue(rec({ release_notes: [noteHigh] }), rel({ total_matches: 0, capped: true }))).toBe('medium');
  });
});

describe('decideRecommendation — relevance Watch (M6)', () => {
  const breaking = rec({ update_type: 'major', signals: { ...emptySignals(), breaking: true }, release_notes: [noteHigh] });
  const dep = rec({ update_type: 'major', signals: { ...emptySignals(), deprecation: true }, release_notes: [noteHigh] });
  const sec = rec({ signals: { ...emptySignals(), security: true } });

  it('downgrades a breaking change with zero usage to Watch', () => {
    expect(decideRecommendation({ record: breaking, blocked: noBlock, risk: 'high', value: 'none', relevance: rel({ total_matches: 0 }) })).toBe('Watch');
  });
  it('does NOT downgrade when the APIs are used', () => {
    expect(decideRecommendation({ record: breaking, blocked: noBlock, risk: 'high', value: 'medium', relevance: rel({ total_matches: 3 }) })).toBe('Review First');
  });
  it('does NOT downgrade on a capped (partial) scan', () => {
    expect(decideRecommendation({ record: breaking, blocked: noBlock, risk: 'high', value: 'none', relevance: rel({ total_matches: 0, capped: true }) })).toBe('Review First');
  });
  it('does NOT downgrade when no valid APIs were searched', () => {
    expect(decideRecommendation({ record: breaking, blocked: noBlock, risk: 'high', value: 'low', relevance: rel({ total_matches: 0, mentioned: 0 }) })).toBe('Review First');
  });
  it('does NOT downgrade a deprecation', () => {
    expect(decideRecommendation({ record: dep, blocked: noBlock, risk: 'high', value: 'none', relevance: rel({ total_matches: 0 }) })).toBe('Review First');
  });
  it('never affects a security update', () => {
    expect(decideRecommendation({ record: sec, blocked: noBlock, risk: 'high', value: 'none', relevance: rel({ total_matches: 0 }) })).toBe('Review First');
  });
});
