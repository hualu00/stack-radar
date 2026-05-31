import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRecommend } from '../src/commands/recommend.js';
import { type ScoredRecord, renderReport } from '../src/report/markdown.js';
import type { ProjectProfile } from '../src/types/profile.js';
import type { Recommendation } from '../src/types/score.js';
import type { StackJson } from '../src/types/stack.js';
import { type UpdateRecord, emptyRequirements, emptySignals } from '../src/types/update.js';

const stack: StackJson = {
  schema_version: '1.0',
  scanned_at: '',
  repo: { name: 'demo', package_manager: 'npm', is_monorepo: false, workspaces: [] },
  runtime: { node_engine: null, typescript_version: null },
  items: [],
};

function record(name: string, over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    name,
    instances: [{ workspace: '.', current_range: '^1', dependency_type: 'dependencies' }],
    locked_version: '1.0.0',
    latest_version: '2.0.0',
    update_type: 'major',
    release_notes: [],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status: 'ok',
    ...over,
  };
}

function scored(name: string, rec: Recommendation): ScoredRecord {
  return {
    record: record(name),
    score: {
      recommendation: rec,
      confidence: 'medium',
      urgency: 'low',
      risk: 'high',
      value: 'low',
      reasons: ['Major update: 1.0.0 → 2.0.0'],
      caveats: ['heuristic value'],
    },
  };
}

describe('renderReport', () => {
  const all = [record('a'), record('b'), record('z', { status: 'not_found', update_type: 'unknown' })];
  const md = renderReport(stack, [scored('a', 'Upgrade Now'), scored('b', 'Blocked')], all, '2026-01-01');

  it('renders header, sections, and item placement', () => {
    expect(md).toContain('# Stack Radar Report — 2026-01-01');
    expect(md).toContain('Repo: demo');
    expect(md).toContain('🔴 Upgrade Now');
    expect(md).toContain('### a: 1.0.0 → 2.0.0');
    expect(md).toContain('⛔ Blocked');
    expect(md).toContain('### b: 1.0.0 → 2.0.0');
    expect(md).toContain('_(none)_'); // empty sections (Safe to Upgrade, etc.)
  });

  it('renders an Appendix with status counts and token usage', () => {
    expect(md).toContain('## Appendix');
    expect(md).toContain('### Data source status');
    expect(md).toContain('not_found: 1');
    expect(md).toContain('N/A (no AI calls');
    expect(md).toContain('| Package | Locked | Latest |');
  });

  it('is deterministic for the same inputs; only the date line changes', () => {
    const a = renderReport(stack, [scored('a', 'Upgrade Now')], all, '2026-01-01');
    const b = renderReport(stack, [scored('a', 'Upgrade Now')], all, '2026-01-01');
    expect(a).toBe(b);
    const c = renderReport(stack, [scored('a', 'Upgrade Now')], all, '2026-02-02');
    expect(c).not.toBe(a);
    expect(c.replace('2026-02-02', '2026-01-01')).toBe(a); // differ only by date
  });
});

const libProfile: ProjectProfile = {
  product_type: 'component_library',
  users_and_scale: 'internal',
  tech_taste: 'conservative',
  hard_constraints: { node: null, browser_support: null, a11y: null, compliance: [] },
  current_pain_points: [],
  upgrade_policy: { major: 'normal_queue', minor: 'normal_queue', patch: 'normal_queue' },
};

function withAdjustment(name: string, baseRec: Recommendation, finalRec: Recommendation, reasons: string[]): ScoredRecord {
  const s = scored(name, baseRec);
  s.score.adjustment = { recommendation: finalRec, changed: baseRec !== finalRec, reasons };
  return s;
}

describe('renderReport with a profile', () => {
  it('shows the profile header and buckets by the FINAL recommendation', () => {
    const s = withAdjustment('lib', 'Review First', 'Watch', ['conservative tech_taste: new major held to watch']);
    const md = renderReport(stack, [s], [record('lib')], '2026-01-01', libProfile);
    expect(md).toContain('Profile: component_library / conservative');
    expect(md).toContain('- **Recommendation:** Watch'); // final, not base
    expect(md).toContain('- Base: urgency=low, risk=high, value=low → Review First');
    expect(md).toContain('- Profile adjustment: Watch (conservative tech_taste: new major held to watch)');
    // placed under the Watch section, not Review First
    expect(md.indexOf('### lib:')).toBeGreaterThan(md.indexOf('⚪ Watch'));
  });

  it('renders "none" when the profile does not change the recommendation', () => {
    const md = renderReport(stack, [withAdjustment('keep', 'Safe to Upgrade', 'Safe to Upgrade', [])], [record('keep')], '2026-01-01', libProfile);
    expect(md).toContain('- Profile adjustment: none');
  });
});

describe('runRecommend', () => {
  function setup(updates: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'sr-rec-'));
    mkdirSync(join(dir, '.stack-radar'), { recursive: true });
    writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack));
    writeFileSync(join(dir, '.stack-radar', 'updates.json'), JSON.stringify(updates));
    return dir;
  }

  it('writes a dated report from stack.json + updates.json', async () => {
    const dir = setup([record('react', { update_type: 'minor', latest_version: '1.5.0', release_notes: [{ version: '1.5.0', url: 'u', source: 'github_release', confidence: 'high' }] })]);
    await runRecommend({ repo: dir, date: '2026-03-03' });
    const md = readFileSync(join(dir, '.stack-radar', 'reports', '2026-03-03.md'), 'utf8');
    expect(md).toContain('# Stack Radar Report — 2026-03-03');
    expect(md).toContain('### react: 1.0.0 → 1.5.0');
    expect(md).toContain('- N/A (no AI calls in this run)'); // no --use-ai
  });

  it('errors on an old updates.json that predates requirements', async () => {
    const dir = setup([{ name: 'x', instances: [], locked_version: '1.0.0', latest_version: '2.0.0', update_type: 'major', release_notes: [], advisories: [], signals: emptySignals(), status: 'ok' }]);
    await expect(runRecommend({ repo: dir, date: '2026-03-03' })).rejects.toThrow(/re-run/);
  });

  it('auto-loads the repo profile and adjusts; --no-profile keeps the base', async () => {
    // A "clean" major: changelog present, no risk signals → base = Review First.
    const cleanMajor = record('big', { update_type: 'major', latest_version: '2.0.0', release_notes: [{ version: '2.0.0', url: 'u', source: 'github_release', confidence: 'high' }] });
    const dir = setup([cleanMajor]);

    await runRecommend({ repo: dir, date: '2026-03-03', noProfile: true, out: join(dir, 'base.md') });
    expect(readFileSync(join(dir, 'base.md'), 'utf8')).toContain('- **Recommendation:** Review First');

    // An aggressive profile (auto-loaded) relaxes the clean major to Safe to Upgrade.
    writeFileSync(join(dir, '.stack-radar', 'project-profile.yaml'), 'product_type: internal_tool\nusers_and_scale: internal\ntech_taste: aggressive\n');
    await runRecommend({ repo: dir, date: '2026-03-03', out: join(dir, 'tool.md') });
    const tool = readFileSync(join(dir, 'tool.md'), 'utf8');
    expect(tool).toContain('Profile: internal_tool / aggressive');
    expect(tool).toContain('- **Recommendation:** Safe to Upgrade');
  });
});
