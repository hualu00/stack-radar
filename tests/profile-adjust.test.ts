import { describe, expect, it } from 'vitest';
import type { AiEvidence } from '../src/types/ai.js';
import type { HardConstraints, ProjectProfile } from '../src/types/profile.js';
import type { ProjectContext, Recommendation, ScoreResult } from '../src/types/score.js';
import { type UpdateRecord, emptyRequirements, emptySignals } from '../src/types/update.js';
import { applyProfile } from '../src/scoring/profile-adjust.js';
import { scoreRecord } from '../src/scoring/index.js';

function base(over: Partial<ScoreResult> = {}): ScoreResult {
  return {
    recommendation: 'Safe to Upgrade',
    confidence: 'medium',
    urgency: 'low',
    risk: 'low',
    value: 'medium',
    reasons: [],
    caveats: [],
    ...over,
  };
}

function hc(node: string | null = null): HardConstraints {
  return { node, browser_support: null, a11y: null, compliance: [] };
}

function profile(over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    product_type: 'business_app',
    users_and_scale: 'internal',
    tech_taste: 'mainstream',
    hard_constraints: hc(),
    current_pain_points: [],
    upgrade_policy: { major: 'normal_queue', minor: 'normal_queue', patch: 'normal_queue' },
    ...over,
  };
}

function rec(over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    name: 'pkg',
    instances: [{ workspace: '.', current_range: '^1', dependency_type: 'dependencies' }],
    locked_version: '1.0.0',
    latest_version: '2.0.0',
    update_type: 'major',
    release_notes: [{ version: '2.0.0', url: 'https://example/r', source: 'github_release', confidence: 'high' }],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status: 'ok',
    ...over,
  };
}

const noProfileCtx: ProjectContext = { nodeEngine: null, lockedByWorkspace: new Map() };

describe('applyProfile — R0 / R1 (block)', () => {
  it('R0: never unblocks a base-blocked record', () => {
    const a = applyProfile(base({ recommendation: 'Blocked' }), profile({ tech_taste: 'aggressive' }), rec());
    expect(a).toEqual({ recommendation: 'Blocked', changed: false, reasons: [] });
  });

  it('R1: blocks when hard_constraints.node is not within the required node', () => {
    const a = applyProfile(base(), profile({ hard_constraints: hc('>=18') }), rec({ requirements: { node: '>=20', peers: {}, optional_peers: [] } }));
    expect(a.recommendation).toBe('Blocked');
    expect(a.changed).toBe(true);
    expect(a.reasons[0]).toMatch(/hard_constraints\.node/);
  });

  it('R1: does not block when the project node is a subset of the requirement', () => {
    const a = applyProfile(base(), profile({ hard_constraints: hc('>=20') }), rec({ requirements: { node: '>=18', peers: {}, optional_peers: [] } }));
    expect(a.recommendation).toBe('Safe to Upgrade');
    expect(a.changed).toBe(false);
  });

  it('R1: no-op when the profile declares no node, or the package requires none', () => {
    expect(applyProfile(base(), profile({ hard_constraints: hc(null) }), rec({ requirements: { node: '>=20', peers: {}, optional_peers: [] } })).changed).toBe(false);
    expect(applyProfile(base(), profile({ hard_constraints: hc('>=18') }), rec({ requirements: emptyRequirements() })).changed).toBe(false);
  });
});

describe('applyProfile — R2 upgrade_policy', () => {
  it('floors a minor at Review First when minor policy is manual_review', () => {
    const a = applyProfile(base({ recommendation: 'Safe to Upgrade' }), profile({ upgrade_policy: { major: 'normal_queue', minor: 'manual_review', patch: 'normal_queue' } }), rec({ update_type: 'minor' }));
    expect(a.recommendation).toBe('Review First');
    expect(a.reasons[0]).toMatch(/upgrade_policy\.minor = manual_review/);
  });

  it('floors a patch when patch policy is manual_review', () => {
    const a = applyProfile(base({ recommendation: 'Safe to Upgrade' }), profile({ upgrade_policy: { major: 'normal_queue', minor: 'normal_queue', patch: 'manual_review' } }), rec({ update_type: 'patch' }));
    expect(a.recommendation).toBe('Review First');
  });

  it('is a no-op when the major is already at Review First', () => {
    const a = applyProfile(base({ recommendation: 'Review First' }), profile({ upgrade_policy: { major: 'manual_review', minor: 'normal_queue', patch: 'normal_queue' } }), rec({ update_type: 'major' }));
    expect(a.recommendation).toBe('Review First');
    expect(a.changed).toBe(false);
  });

  it('does not floor when policy is normal_queue', () => {
    expect(applyProfile(base(), profile(), rec({ update_type: 'minor' })).changed).toBe(false);
  });
});

describe('applyProfile — R3 product_type peer change', () => {
  it('raises a library peer change to Watch', () => {
    for (const product_type of ['component_library', 'sdk'] as const) {
      const a = applyProfile(base({ recommendation: 'Review First' }), profile({ product_type }), rec({ update_type: 'minor', signals: { ...emptySignals(), peer_dependency_changed: true } }));
      expect(a.recommendation).toBe('Watch');
      expect(a.reasons[0]).toMatch(/peerDependencies changed/);
    }
  });

  it('does not apply to a business_app', () => {
    expect(applyProfile(base({ recommendation: 'Review First' }), profile({ product_type: 'business_app' }), rec({ signals: { ...emptySignals(), peer_dependency_changed: true } })).changed).toBe(false);
  });

  it('never lowers caution (Defer stays Defer)', () => {
    expect(applyProfile(base({ recommendation: 'Defer' }), profile({ product_type: 'component_library' }), rec({ signals: { ...emptySignals(), peer_dependency_changed: true } })).recommendation).toBe('Defer');
  });
});

describe('applyProfile — R4 tech_taste', () => {
  it('conservative raises a new major to Watch', () => {
    expect(applyProfile(base({ recommendation: 'Review First' }), profile({ tech_taste: 'conservative' }), rec({ update_type: 'major' })).recommendation).toBe('Watch');
  });

  it('mainstream leaves a major at Review First', () => {
    expect(applyProfile(base({ recommendation: 'Review First' }), profile({ tech_taste: 'mainstream' }), rec({ update_type: 'major' })).changed).toBe(false);
  });

  it('aggressive relaxes a clean major to Safe to Upgrade', () => {
    const a = applyProfile(base({ recommendation: 'Review First' }), profile({ tech_taste: 'aggressive' }), rec({ update_type: 'major' }));
    expect(a.recommendation).toBe('Safe to Upgrade');
    expect(a.reasons[0]).toMatch(/aggressive tech_taste/);
  });

  it('aggressive does NOT relax when policy.major is manual_review (policy wins)', () => {
    const a = applyProfile(base({ recommendation: 'Review First' }), profile({ tech_taste: 'aggressive', upgrade_policy: { major: 'manual_review', minor: 'normal_queue', patch: 'normal_queue' } }), rec({ update_type: 'major' }));
    expect(a.recommendation).toBe('Review First');
    expect(a.changed).toBe(false);
  });

  it('aggressive does NOT relax a major with a risk signal or no changelog', () => {
    expect(applyProfile(base({ recommendation: 'Review First' }), profile({ tech_taste: 'aggressive' }), rec({ update_type: 'major', signals: { ...emptySignals(), breaking: true } })).changed).toBe(false);
    expect(applyProfile(base({ recommendation: 'Review First' }), profile({ tech_taste: 'aggressive' }), rec({ update_type: 'major', release_notes: [] })).changed).toBe(false);
  });
});

describe('applyProfile — security exemption', () => {
  it('conservative does not bury a security major under Watch', () => {
    const a = applyProfile(base({ recommendation: 'Review First' }), profile({ tech_taste: 'conservative' }), rec({ update_type: 'major', signals: { ...emptySignals(), security: true } }));
    expect(a.recommendation).toBe('Review First');
    expect(a.changed).toBe(false);
  });

  it('a library security+peer change is not pushed to Watch', () => {
    const a = applyProfile(base({ recommendation: 'Review First' }), profile({ product_type: 'component_library' }), rec({ signals: { ...emptySignals(), security: true, peer_dependency_changed: true } }));
    expect(a.recommendation).toBe('Review First');
  });
});

describe('applyProfile — three project types diverge on one clean major', () => {
  it('library→Watch, app→Review First, internal tool→Safe to Upgrade', () => {
    const cleanMajor = rec({ update_type: 'major' });
    const start = base({ recommendation: 'Review First' });
    const lib = applyProfile(start, profile({ product_type: 'component_library', tech_taste: 'conservative', upgrade_policy: { major: 'manual_review', minor: 'manual_review', patch: 'normal_queue' } }), cleanMajor);
    const app = applyProfile(start, profile({ product_type: 'business_app', tech_taste: 'mainstream' }), cleanMajor);
    const tool = applyProfile(start, profile({ product_type: 'internal_tool', tech_taste: 'aggressive' }), cleanMajor);
    expect([lib.recommendation, app.recommendation, tool.recommendation]).toEqual(['Watch', 'Review First', 'Safe to Upgrade']);
  });
});

describe('scoreRecord integration', () => {
  it('omits adjustment when no profile is given', () => {
    expect(scoreRecord(rec({ update_type: 'minor' }), noProfileCtx).adjustment).toBeUndefined();
  });

  it('attaches adjustment and keeps base recommendation as the base', () => {
    const s = scoreRecord(rec({ update_type: 'major' }), noProfileCtx, profile({ tech_taste: 'aggressive' }));
    expect(s.recommendation).toBe('Review First'); // base
    expect(s.adjustment?.recommendation).toBe('Safe to Upgrade'); // adjusted
  });

  it('is deterministic', () => {
    const p = profile({ tech_taste: 'aggressive' });
    expect(scoreRecord(rec({ update_type: 'major' }), noProfileCtx, p)).toEqual(scoreRecord(rec({ update_type: 'major' }), noProfileCtx, p));
  });
});

function evidenceWithPerf(perf: string[]): AiEvidence {
  return {
    package: 'pkg',
    summary: '',
    evidence: [],
    extracted_signals: { security_related: false, breaking_changes: [], deprecations: [], bugfixes: [], performance_improvements: perf, new_features: [] },
    mentioned_apis: [],
    evidence_quality: 'high',
    caveats: [],
  };
}

describe('applyProfile — R5 performance pain-point (M6)', () => {
  const perfProfile = profile({ current_pain_points: ['table virtualization perf', 'build is slow'] });
  const perfEvidence = evidenceWithPerf(['2x faster initial render']);

  it('elevates a Safe-to-Upgrade that fixes a perf pain point to Upgrade Now', () => {
    const a = applyProfile(base({ recommendation: 'Safe to Upgrade' }), perfProfile, rec({ update_type: 'minor' }), perfEvidence);
    expect(a.recommendation).toBe('Upgrade Now');
    expect(a.reasons[0]).toMatch(/performance pain point/i);
  });
  it('no elevation without a perf pain point', () => {
    expect(applyProfile(base({ recommendation: 'Safe to Upgrade' }), profile({ current_pain_points: ['a11y gaps'] }), rec({ update_type: 'minor' }), perfEvidence).changed).toBe(false);
  });
  it('no elevation without performance_improvements evidence', () => {
    expect(applyProfile(base({ recommendation: 'Safe to Upgrade' }), perfProfile, rec({ update_type: 'minor' }), evidenceWithPerf([])).changed).toBe(false);
  });
  it('no elevation when there is no AI evidence at all', () => {
    expect(applyProfile(base({ recommendation: 'Safe to Upgrade' }), perfProfile, rec({ update_type: 'minor' })).changed).toBe(false);
  });
  it('only touches Safe to Upgrade (leaves Review First alone)', () => {
    expect(applyProfile(base({ recommendation: 'Review First' }), perfProfile, rec({ update_type: 'minor' }), perfEvidence).recommendation).toBe('Review First');
  });
  it('does NOT fire on high base risk (e.g. an aggressively-relaxed major)', () => {
    const a = applyProfile(base({ recommendation: 'Safe to Upgrade', risk: 'high' }), perfProfile, rec({ update_type: 'major' }), perfEvidence);
    expect(a.changed).toBe(false);
  });
  it('does NOT fire when relevance proved the change is irrelevant (value none)', () => {
    const a = applyProfile(base({ recommendation: 'Safe to Upgrade', value: 'none' }), perfProfile, rec({ update_type: 'minor' }), perfEvidence);
    expect(a.changed).toBe(false);
  });
  it('does not elevate a security update', () => {
    const a = applyProfile(base({ recommendation: 'Safe to Upgrade' }), perfProfile, rec({ update_type: 'minor', signals: { ...emptySignals(), security: true } }), perfEvidence);
    expect(a.changed).toBe(false);
  });
});
