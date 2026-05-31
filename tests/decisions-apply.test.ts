import { describe, expect, it } from 'vitest';
import { applyDecision, effectiveRecommendation, isActiveSnooze, resolveDecision } from '../src/decisions/apply.js';
import type { Decision, DecisionEffect, DecisionsFile } from '../src/types/decision.js';
import type { Recommendation, ScoreResult } from '../src/types/score.js';
import { type UpdateRecord, emptyRequirements, emptySignals } from '../src/types/update.js';

function rec(over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    name: 'react',
    instances: [{ workspace: '.', current_range: '^18', dependency_type: 'dependencies' }],
    locked_version: '18.3.1',
    latest_version: '19.0.0',
    update_type: 'major',
    release_notes: [],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status: 'ok',
    ...over,
  };
}

const AT = (s: string) => `2026-05-${s}T10:00:00.000Z`;
function dec(over: Partial<Decision> = {}): Decision {
  return { package: 'react', action: 'accept', created_at: AT('27'), ...over };
}
function file(...decisions: Decision[]): DecisionsFile {
  return { version: 1, decisions };
}

describe('resolveDecision — matching', () => {
  it('matches a package-wide decision by name', () => {
    expect(resolveDecision(rec(), file(dec()))?.action).toBe('accept');
  });

  it('matches by resolved_name (alias)', () => {
    const r = rec({ name: 'my-react', resolved_name: 'react' });
    expect(resolveDecision(r, file(dec({ package: 'react' })))).not.toBeNull();
    expect(resolveDecision(r, file(dec({ package: 'my-react' })))).not.toBeNull();
    expect(resolveDecision(r, file(dec({ package: 'preact' })))).toBeNull();
  });

  it('honors version_range against latest_version (incl. prerelease)', () => {
    const snooze = dec({ action: 'snooze', until: '2026-12-31', version_range: '19.x' });
    expect(resolveDecision(rec({ latest_version: '19.5.0' }), file(snooze))).not.toBeNull();
    expect(resolveDecision(rec({ latest_version: '20.0.0' }), file(snooze))).toBeNull(); // 19.x ≠ 20
    expect(resolveDecision(rec({ latest_version: '19.1.0-rc.1' }), file(snooze))).not.toBeNull(); // prerelease in range
  });

  it('returns null when latest_version is unknown but a range was required', () => {
    expect(resolveDecision(rec({ latest_version: null }), file(dec({ version_range: '19.x' })))).toBeNull();
  });
});

describe('resolveDecision — precedence among multiple matches', () => {
  it('newest created_at wins', () => {
    const older = dec({ action: 'decline', created_at: AT('20') });
    const newer = dec({ action: 'accept', created_at: AT('27') });
    expect(resolveDecision(rec(), file(older, newer))?.action).toBe('accept');
  });

  it('on equal created_at, range-scoped beats package-wide', () => {
    const wide = dec({ action: 'decline', created_at: AT('27') });
    const scoped = dec({ action: 'snooze', until: '2026-12-31', version_range: '19.x', created_at: AT('27') });
    expect(resolveDecision(rec({ latest_version: '19.5.0' }), file(wide, scoped))?.action).toBe('snooze');
  });
});

describe('isActiveSnooze — date boundary', () => {
  const snooze = dec({ action: 'snooze', until: '2026-06-01' });
  it('is active before until, expired on/after until', () => {
    expect(isActiveSnooze(snooze, '2026-05-31')).toBe(true);
    expect(isActiveSnooze(snooze, '2026-06-01')).toBe(false); // resurfaces ON the date
    expect(isActiveSnooze(snooze, '2026-06-02')).toBe(false);
  });
  it('is false for non-snooze actions', () => {
    expect(isActiveSnooze(dec({ action: 'accept' }), '2026-01-01')).toBe(false);
  });
});

describe('applyDecision', () => {
  const DATE = '2026-05-27';

  it('accept → marker only, recommendation unchanged, not hidden', () => {
    const e = applyDecision('Review First', rec(), dec({ action: 'accept' }), DATE);
    expect(e).toMatchObject({ action: 'accept', recommendation: 'Review First', hidden: false, marker: 'previously accepted' });
  });

  it('active snooze → hidden with a dated marker', () => {
    const e = applyDecision('Review First', rec(), dec({ action: 'snooze', until: '2026-12-31' }), DATE);
    expect(e).toMatchObject({ hidden: true, marker: 'snoozed until 2026-12-31' });
  });

  it('expired snooze → undefined (resurfaces)', () => {
    const e = applyDecision('Review First', rec(), dec({ action: 'snooze', until: '2026-01-01' }), DATE);
    expect(e).toBeUndefined();
  });

  it('no decision → undefined', () => {
    expect(applyDecision('Review First', rec(), null, DATE)).toBeUndefined();
  });

  it('non-security decline de-emphasizes per the table', () => {
    const d = dec({ action: 'decline' });
    const eff = (base: Recommendation) => applyDecision(base, rec(), d, DATE)?.recommendation;
    expect(eff('Upgrade Now')).toBe('Watch'); // non-security Upgrade Now (e.g. R5 perf-pain) drops
    expect(eff('Safe to Upgrade')).toBe('Watch');
    expect(eff('Review First')).toBe('Watch');
    expect(eff('Watch')).toBe('Watch');
    expect(eff('Defer')).toBe('Defer'); // already as cautious
    expect(eff('Blocked')).toBe('Blocked');
  });

  it('decline is overridden when the version carries a security signal — rec preserved, even Blocked', () => {
    const r = rec({ signals: { ...emptySignals(), security: true } });
    const e = applyDecision('Blocked', r, dec({ action: 'decline' }), DATE);
    expect(e).toMatchObject({ securityOverride: true, recommendation: 'Blocked', hidden: false });
    expect(e?.marker).toMatch(/security advisory/);
  });

  it('decline is overridden when an advisory entry exists even without the signal', () => {
    const r = rec({ advisories: [{ id: 'GHSA-x', source: 'osv' }] });
    const e = applyDecision('Safe to Upgrade', r, dec({ action: 'decline' }), DATE);
    expect(e).toMatchObject({ securityOverride: true, recommendation: 'Safe to Upgrade' });
  });
});

describe('effectiveRecommendation', () => {
  const score = { recommendation: 'Review First', adjustment: { recommendation: 'Watch', changed: true, reasons: [] } } as ScoreResult;
  it('uses the decision recommendation when present, else finalRecommendation(score)', () => {
    expect(effectiveRecommendation(score)).toBe('Watch'); // profile-adjusted base
    const declined: DecisionEffect = { action: 'decline', recommendation: 'Watch', hidden: false, marker: '', securityOverride: false };
    expect(effectiveRecommendation({ ...score, adjustment: undefined } as ScoreResult, declined)).toBe('Watch');
  });
});
