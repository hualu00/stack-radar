import { describe, expect, it } from 'vitest';
import { validateEvidence } from '../src/ai/validate.js';
import type { AnalysisInput } from '../src/types/ai.js';

const input: AnalysisInput = {
  package: 'react',
  locked_version: '18.0.0',
  latest_version: '19.0.0',
  update_type: 'major',
  notes: [{ version: '19.0.0', url: 'https://gh/19', source: 'github_release', text: 'Added the use() hook. BREAKING: removed defaultProps.' }],
  profile: null,
};

function rawOk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    package: 'IGNORED-echo',
    summary: 'React 19 adds use() and removes defaultProps.',
    evidence: [{ version: '19.0.0', type: 'breaking', quote: 'BREAKING: removed defaultProps.', url: 'https://gh/19' }],
    extracted_signals: { security_related: false, breaking_changes: ['removed defaultProps'], deprecations: [], bugfixes: [], performance_improvements: [], new_features: ['use() hook'] },
    mentioned_apis: ['use'],
    evidence_quality: 'high',
    caveats: [],
    ...over,
  };
}

describe('validateEvidence', () => {
  it('keeps a quote that is an exact substring of the cited note', () => {
    const r = validateEvidence(rawOk(), input);
    expect(r.scrubbed).toBe(false);
    expect(r.evidence.evidence).toHaveLength(1);
    expect(r.evidence.evidence[0]?.quote).toContain('defaultProps');
    expect(r.evidence.evidence_quality).toBe('high');
    expect(r.evidence.package).toBe('react'); // forced — not the model's echoed name
  });

  it('drops a fabricated quote and forces quality low + a caveat', () => {
    const r = validateEvidence(rawOk({ evidence: [{ version: '19', type: 'feature', quote: 'Adds telepathic rendering.', url: 'https://gh/19' }] }), input);
    expect(r.scrubbed).toBe(true);
    expect(r.evidence.evidence).toHaveLength(0);
    expect(r.evidence.evidence_quality).toBe('low');
    expect(r.evidence.caveats.join(' ')).toMatch(/did not match/i);
  });

  it('drops a quote citing a URL we never supplied', () => {
    const r = validateEvidence(rawOk({ evidence: [{ version: '19', type: 'breaking', quote: 'BREAKING: removed defaultProps.', url: 'https://evil/x' }] }), input);
    expect(r.evidence.evidence).toHaveLength(0);
    expect(r.scrubbed).toBe(true);
  });

  it('coerces an unknown evidence type to "other"', () => {
    const r = validateEvidence(rawOk({ evidence: [{ version: '19.0.0', type: 'wat', quote: 'Added the use() hook.', url: 'https://gh/19' }] }), input);
    expect(r.evidence.evidence[0]?.type).toBe('other');
    expect(r.scrubbed).toBe(false);
  });

  it('returns low-quality evidence for malformed (non-object) output', () => {
    const r = validateEvidence(null, input);
    expect(r.evidence.evidence_quality).toBe('low');
    expect(r.scrubbed).toBe(true);
  });

  it('clamps an out-of-range evidence_quality to low', () => {
    expect(validateEvidence(rawOk({ evidence_quality: 'amazing' }), input).evidence.evidence_quality).toBe('low');
  });

  it('grounds mentioned_apis to names present in the supplied changelog text', () => {
    const r = validateEvidence(rawOk({ mentioned_apis: ['use', 'telepathy', 'defaultProps'] }), input);
    // 'use' (in 'use() hook') and 'defaultProps' appear as whole identifiers; 'telepathy' is invented → dropped.
    expect(r.evidence.mentioned_apis).toEqual(['use', 'defaultProps']);
  });

  it('requires a whole-identifier match, not a mere substring of a larger word', () => {
    const customInput: AnalysisInput = { ...input, notes: [{ version: '19.0.0', url: 'https://gh/19', source: 'github_release', text: 'This release improves how users react to changes.' }] };
    const r = validateEvidence(rawOk({ evidence: [], mentioned_apis: ['use', 'act', 'react', 'users'] }), customInput);
    // 'use' (inside 'users') and 'act' (inside 'react') are not standalone → dropped; 'react'/'users' are whole words → kept.
    expect(r.evidence.mentioned_apis).toEqual(['react', 'users']);
  });

  it('drops performance_improvements unless a grounded performance evidence item backs them', () => {
    const r = validateEvidence(
      rawOk({ extracted_signals: { security_related: false, breaking_changes: [], deprecations: [], bugfixes: [], performance_improvements: ['2x faster'], new_features: [] } }),
      input,
    );
    expect(r.evidence.extracted_signals.performance_improvements).toEqual([]); // only a 'breaking' quote → not grounded
    expect(r.evidence.caveats.join(' ')).toMatch(/performance improvements/i);
  });

  it('keeps performance_improvements when a grounded performance quote is present', () => {
    const r = validateEvidence(
      rawOk({
        evidence: [{ version: '19.0.0', type: 'performance', quote: 'Added the use() hook.', url: 'https://gh/19' }],
        extracted_signals: { security_related: false, breaking_changes: [], deprecations: [], bugfixes: [], performance_improvements: ['faster startup'], new_features: [] },
      }),
      input,
    );
    expect(r.evidence.extracted_signals.performance_improvements).toEqual(['faster startup']);
    expect(r.scrubbed).toBe(false);
  });

  it('keeps non-string signal entries out', () => {
    const r = validateEvidence(rawOk({ extracted_signals: { security_related: 'yes', breaking_changes: ['ok', 42, null], deprecations: [], bugfixes: [], performance_improvements: [], new_features: [] } }), input);
    expect(r.evidence.extracted_signals.security_related).toBe(false); // only `true` is truthy
    expect(r.evidence.extracted_signals.breaking_changes).toEqual(['ok']);
  });
});
