import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runRecommend } from '../src/commands/recommend.js';
import type { AiEvidence, AnalysisInput, TokenUsage } from '../src/types/ai.js';
import type { Relevance } from '../src/types/relevance.js';
import type { StackJson } from '../src/types/stack.js';
import { type UpdateRecord, emptyRequirements, emptySignals } from '../src/types/update.js';

const stack: StackJson = {
  schema_version: '1.0',
  scanned_at: '',
  repo: { name: 'demo', package_manager: 'npm', is_monorepo: false, workspaces: [] },
  runtime: { node_engine: null, typescript_version: null },
  items: [],
};

function rec(name: string, over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    name,
    instances: [{ workspace: '.', current_range: '^1', dependency_type: 'dependencies' }],
    locked_version: '1.0.0',
    latest_version: '2.0.0',
    update_type: 'major',
    release_notes: [{ version: '2.0.0', url: 'https://gh/2', source: 'github_release', confidence: 'high', text: 'BREAKING: removed foo()' }],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status: 'ok',
    ...over,
  };
}

function setup(updates: UpdateRecord[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-recai-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack));
  writeFileSync(join(dir, '.stack-radar', 'updates.json'), JSON.stringify(updates));
  return dir;
}

const usage: TokenUsage = { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function highEvidence(input: AnalysisInput): AiEvidence {
  return {
    package: input.package,
    summary: `Upgrading ${input.package} removes foo().`,
    evidence: [{ version: '2.0.0', type: 'breaking', quote: 'BREAKING: removed foo()', url: 'https://gh/2' }],
    extracted_signals: { security_related: false, breaking_changes: ['removed foo()'], deprecations: [], bugfixes: [], performance_improvements: [], new_features: [] },
    mentioned_apis: ['foo'],
    evidence_quality: 'high',
    caveats: [],
  };
}

/** Offline fake AI client honoring the injection seam. */
function fakeClient(make: (input: AnalysisInput) => AiEvidence) {
  return { analyze: async (input: AnalysisInput) => ({ evidence: make(input), usage, cached: false }) };
}

/** Offline fake searchers (no ripgrep) — "everything used" vs "nothing used". */
const usedSearcher = {
  search: async (_repo: string, apis: string[]): Promise<Relevance> => ({
    scanned: true,
    mentioned: apis.length,
    capped: false,
    apis: apis.map((a) => ({ api: a, match_count: 2, file_count: 1 })),
    total_matches: apis.length * 2,
  }),
};
const unusedSearcher = {
  search: async (_repo: string, apis: string[]): Promise<Relevance> => ({
    scanned: true,
    mentioned: apis.length,
    capped: false,
    apis: apis.map((a) => ({ api: a, match_count: 0, file_count: 0 })),
    total_matches: 0,
  }),
};

describe('runRecommend --use-ai (injected client)', () => {
  it('threads the AI summary + validated quotes into the report and records token usage', async () => {
    const dir = setup([rec('pkg')]);
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiClient: fakeClient(highEvidence), searcher: usedSearcher, out: join(dir, 'r.md') });
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    expect(md).toContain('removes foo().'); // AI summary leads the Why section
    expect(md).toContain('"BREAKING: removed foo()"'); // AI quote in Evidence
    expect(md).toContain('Evidence quality:** high (AI)');
    expect(md).toContain('AI model:');
    expect(md).toContain('100 input / 40 output');
  });

  it('floors confidence to low when evidence_quality is low (would otherwise be high)', async () => {
    const dir = setup([rec('pkg')]); // github_release note → base confidence high
    const lowEv = (input: AnalysisInput): AiEvidence => ({ ...highEvidence(input), evidence_quality: 'low', evidence: [] });
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiClient: fakeClient(lowEv), searcher: usedSearcher, out: join(dir, 'r.md') });
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain('- **Confidence:** low');
  });

  it('is deterministic for the same inputs', async () => {
    const dir = setup([rec('pkg')]);
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiClient: fakeClient(highEvidence), searcher: usedSearcher, out: join(dir, 'a.md') });
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiClient: fakeClient(highEvidence), searcher: usedSearcher, out: join(dir, 'b.md') });
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(readFileSync(join(dir, 'b.md'), 'utf8'));
  });

  it('--dry-run prints prompts (with changelog text) and makes no API calls; no source leaks', async () => {
    const dir = setup([rec('pkg')]);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      // No aiClient injected → real createAiClient in dry-run mode returns before any
      // transport call, so this stays offline and needs no API key.
      await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, dryRun: true, out: join(dir, 'r.md') });
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('AI PROMPT: pkg');
    expect(out).toContain('BREAKING: removed foo()'); // changelog text IS in the prompt
    expect(out).not.toContain('function __steal'); // a source sentinel never is
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain('AI dry-run');
  });
});

describe('runRecommend --use-ai code relevance (M6)', () => {
  it('renders a Project relevance section from the AI mentioned_apis', async () => {
    const dir = setup([rec('pkg')]);
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiClient: fakeClient(highEvidence), searcher: usedSearcher, out: join(dir, 'r.md') });
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    expect(md).toContain('**Project relevance**');
    expect(md).toContain('foo: 2 matches across 1 files'); // highEvidence.mentioned_apis = ['foo']
  });

  it('downgrades a breaking change with zero usage to Watch', async () => {
    const dir = setup([rec('pkg', { update_type: 'major', signals: { ...emptySignals(), breaking: true } })]);
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiClient: fakeClient(highEvidence), searcher: unusedSearcher, out: join(dir, 'r.md') });
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    expect(md).toContain('- **Recommendation:** Watch');
    expect(md).toContain('None of the changed APIs appear in this project');
  });

  it('R5: a low-risk perf fix matching a pain point is elevated to Upgrade Now', async () => {
    const dir = setup([rec('pkg', { update_type: 'minor' })]);
    writeFileSync(join(dir, '.stack-radar', 'project-profile.yaml'), 'product_type: business_app\nusers_and_scale: internal\ntech_taste: mainstream\ncurrent_pain_points:\n  - "table render is slow"\n');
    const perfEvidence = (input: AnalysisInput): AiEvidence => ({
      ...highEvidence(input),
      extracted_signals: { security_related: false, breaking_changes: [], deprecations: [], bugfixes: [], performance_improvements: ['2x faster initial render'], new_features: [] },
    });
    await runRecommend({ repo: dir, date: '2026-03-03', useAi: true, aiClient: fakeClient(perfEvidence), searcher: usedSearcher, out: join(dir, 'r.md') });
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    expect(md).toContain('- **Recommendation:** Upgrade Now');
    expect(md).toContain('matches a current performance pain point');
  });
});
