import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DecisionError,
  decisionKey,
  isIsoDate,
  loadDecisions,
  parseDecisions,
  upsertDecision,
  validateDecision,
  writeDecisions,
} from '../src/decisions/store.js';
import type { Decision, DecisionsFile } from '../src/types/decision.js';

const AT = '2026-05-27T10:00:00.000Z';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-dec-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  return dir;
}

describe('isIsoDate', () => {
  it('accepts real YYYY-MM-DD dates and rejects malformed / impossible ones', () => {
    expect(isIsoDate('2026-12-31')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false); // no month 13
    expect(isIsoDate('2026-02-30')).toBe(false); // no Feb 30
    expect(isIsoDate('2026-1-1')).toBe(false); // not zero-padded
    expect(isIsoDate('2026-Q3')).toBe(false); // quarter syntax unsupported
    expect(isIsoDate('not-a-date')).toBe(false);
  });
});

describe('validateDecision', () => {
  it('accepts a minimal accept decision', () => {
    const d = validateDecision({ package: 'react', action: 'accept', created_at: AT });
    expect(d).toEqual({ package: 'react', action: 'accept', created_at: AT });
  });

  it('requires a non-empty package and a known action', () => {
    expect(() => validateDecision({ package: '', action: 'accept', created_at: AT })).toThrow(DecisionError);
    expect(() => validateDecision({ package: 'react', action: 'nope', created_at: AT })).toThrow(/action must be one of/);
  });

  it('requires a valid created_at', () => {
    expect(() => validateDecision({ package: 'react', action: 'accept', created_at: 'whenever' })).toThrow(/created_at/);
    expect(() => validateDecision({ package: 'react', action: 'accept' })).toThrow(/created_at/);
  });

  it('requires until (YYYY-MM-DD) for snooze and forbids it otherwise', () => {
    expect(() => validateDecision({ package: 'react', action: 'snooze', created_at: AT })).toThrow(/snooze requires/);
    expect(() => validateDecision({ package: 'react', action: 'snooze', until: '2026-Q3', created_at: AT })).toThrow(/YYYY-MM-DD/);
    expect(validateDecision({ package: 'react', action: 'snooze', until: '2026-12-31', created_at: AT }).until).toBe('2026-12-31');
    expect(() => validateDecision({ package: 'react', action: 'decline', until: '2026-12-31', created_at: AT })).toThrow(/only valid for a snooze/);
  });

  it('validates version_range as a semver range and rejects the everything-matching forms', () => {
    expect(() => validateDecision({ package: 'react', action: 'accept', version_range: 'not-a-range!!', created_at: AT })).toThrow(/version_range/);
    expect(validateDecision({ package: 'react', action: 'accept', version_range: '19.x', created_at: AT }).version_range).toBe('19.x');
    expect(validateDecision({ package: 'react', action: 'accept', version_range: '  19.x  ', created_at: AT }).version_range).toBe('19.x'); // trimmed
    expect(() => validateDecision({ package: 'react', action: 'accept', version_range: '', created_at: AT })).toThrow(/version_range/);
    expect(() => validateDecision({ package: 'react', action: 'accept', version_range: '*', created_at: AT })).toThrow(/matches every version/);
  });

  it('requires a canonical ISO instant for created_at (not just any Date.parse-able string)', () => {
    expect(() => validateDecision({ package: 'react', action: 'accept', created_at: '123' })).toThrow(/created_at/);
    expect(() => validateDecision({ package: 'react', action: 'accept', created_at: '2026-05-27' })).toThrow(/created_at/);
    expect(validateDecision({ package: 'react', action: 'accept', created_at: AT }).created_at).toBe(AT);
  });

  it('rejects unknown keys (e.g. a versionRange typo that would silently widen scope)', () => {
    expect(() => validateDecision({ package: 'react', action: 'accept', versionRange: '19.x', created_at: AT })).toThrow(/unknown key/);
  });
});

describe('parseDecisions', () => {
  it('rejects a bad version and a non-array decisions field', () => {
    expect(() => parseDecisions({ version: 2, decisions: [] })).toThrow(/version must be 1/);
    expect(() => parseDecisions({ version: 1, decisions: {} })).toThrow(/must be an array/);
  });

  it('rejects duplicate (package, version_range) keys', () => {
    const dup = {
      version: 1,
      decisions: [
        { package: 'react', action: 'accept', created_at: AT },
        { package: 'react', action: 'decline', created_at: AT },
      ],
    };
    expect(() => parseDecisions(dup)).toThrow(/duplicate/);
  });

  it('allows the same package with different ranges', () => {
    const file = parseDecisions({
      version: 1,
      decisions: [
        { package: 'react', action: 'decline', created_at: AT },
        { package: 'react', action: 'snooze', version_range: '19.x', until: '2026-12-31', created_at: AT },
      ],
    });
    expect(file.decisions).toHaveLength(2);
  });
});

describe('upsertDecision', () => {
  const snooze: Decision = { package: 'react', action: 'snooze', until: '2026-12-31', created_at: AT };
  const accept: Decision = { package: 'react', action: 'accept', created_at: '2026-05-28T10:00:00.000Z' };

  it('replaces a decision with the same (package, range) — accept supersedes snooze', () => {
    const file = upsertDecision({ version: 1, decisions: [snooze] }, accept);
    expect(file.decisions).toHaveLength(1);
    expect(file.decisions[0]?.action).toBe('accept');
  });

  it('keeps decisions with different ranges side by side', () => {
    const ranged: Decision = { package: 'react', action: 'snooze', version_range: '19.x', until: '2026-12-31', created_at: AT };
    const file = upsertDecision({ version: 1, decisions: [snooze] }, ranged);
    expect(file.decisions).toHaveLength(2);
    expect(file.decisions.map(decisionKey).sort()).toEqual(['react@@', 'react@@19.x']);
  });
});

describe('loadDecisions / writeDecisions round-trip', () => {
  it('returns an empty file when none exists', () => {
    expect(loadDecisions(repo())).toEqual({ version: 1, decisions: [] });
  });

  it('throws on a present-but-malformed file (not silently empty)', () => {
    const dir = repo();
    writeFileSync(join(dir, '.stack-radar', 'decisions.json'), '{ not json', 'utf8');
    expect(() => loadDecisions(dir)).toThrow(DecisionError);
  });

  it('persists deterministically and reloads identically', () => {
    const dir = repo();
    const file: DecisionsFile = upsertDecision(
      { version: 1, decisions: [] },
      { package: 'vite', action: 'accept', created_at: AT },
    );
    writeDecisions(dir, file);
    writeDecisions(dir, file);
    expect(loadDecisions(dir)).toEqual(file);
    expect(readFileSync(join(dir, '.stack-radar', 'decisions.json'), 'utf8').endsWith('\n')).toBe(true);
  });
});
