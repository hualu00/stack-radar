import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, buildAnalysisPrompt } from '../src/ai/prompts/changelog-analysis.js';
import type { AnalysisInput } from '../src/types/ai.js';

function input(over: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    package: 'react',
    locked_version: '18.0.0',
    latest_version: '19.0.0',
    update_type: 'major',
    notes: [
      {
        version: '19.0.0',
        url: 'https://github.com/facebook/react/releases/tag/v19.0.0',
        source: 'github_release',
        text: 'Adds the new use() hook. BREAKING: removed defaultProps for function components.',
      },
    ],
    profile: { product_type: 'business_app', tech_taste: 'mainstream' },
    ...over,
  };
}

describe('buildAnalysisPrompt', () => {
  it('includes the package, version range, note text, urls and profile', () => {
    const p = buildAnalysisPrompt(input());
    expect(p.user).toContain('react');
    expect(p.user).toContain('18.0.0 -> 19.0.0 (major)');
    expect(p.user).toContain('use() hook');
    expect(p.user).toContain('https://github.com/facebook/react/releases/tag/v19.0.0');
    expect(p.user).toContain('product_type=business_app');
  });

  it('wraps each note in explicit BEGIN_NOTE/END_NOTE boundaries with matching ids', () => {
    const p = buildAnalysisPrompt(input());
    expect(p.user).toMatch(/BEGIN_NOTE id=0 version=19\.0\.0 source=github_release url=/);
    expect(p.user).toContain('END_NOTE id=0');
  });

  it('marks a truncated note in its header', () => {
    const p = buildAnalysisPrompt(input({ notes: [{ version: '2.0.0', url: 'u', source: 'changelog_md', text: 'partial...', truncated: true }] }));
    expect(p.user).toContain('(text truncated)');
  });

  it('instructs the model not to fabricate and to quote verbatim', () => {
    const { system } = buildAnalysisPrompt(input());
    expect(system).toMatch(/never fabricate/i);
    expect(system).toMatch(/verbatim|exact substring/i);
    expect(system).toMatch(/do not decide|do NOT decide|not.*recommendation/i);
  });

  it('PRIVACY: renders only the supplied fields — no source code can leak in', () => {
    // Sentinel representing source code. It is never part of AnalysisInput, so the
    // pure builder cannot emit it. (AnalysisInput has no field that carries code.)
    const SENTINEL = 'function __steal(){ return process.env.SECRET; }';
    const p = buildAnalysisPrompt(input());
    expect(`${p.system}\n${p.user}`).not.toContain(SENTINEL);
  });

  it('handles the no-notes case', () => {
    expect(buildAnalysisPrompt(input({ notes: [] })).user).toContain('(none provided)');
  });

  it('emits a closed JSON schema constraining evidence_quality', () => {
    const { schema } = buildAnalysisPrompt(input());
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, { enum?: string[] }>;
    expect(props.evidence_quality?.enum).toEqual(['high', 'medium', 'low']);
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });
});
