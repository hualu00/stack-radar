import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runRecommend } from '../src/commands/recommend.js';
import { evaluateBlocked, nodeEngineDivergenceNote, resolveProjectNode } from '../src/scoring/blocked.js';
import { buildProjectContext, scoreRecord } from '../src/scoring/index.js';
import type { ProjectProfile } from '../src/types/profile.js';
import type { StackJson } from '../src/types/stack.js';
import { type UpdateRecord, emptyRequirements, emptySignals } from '../src/types/update.js';

const REQUIRED_NODE = '^20.19.0 || >=22.12.0';

function stack(over: { enginesNode?: string | null; nvmrc?: string | null } = {}): StackJson {
  return {
    schema_version: '1.0',
    scanned_at: '',
    repo: { name: 'demo', package_manager: 'npm', is_monorepo: false, workspaces: [] },
    runtime: {
      node_engine: over.enginesNode ?? null,
      nvmrc: over.nvmrc ?? null,
      typescript_version: null,
    },
    items: [],
  };
}

function record(over: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    name: 'node-pkg',
    instances: [{ workspace: '.', current_range: '^1', dependency_type: 'dependencies' }],
    locked_version: '1.0.0',
    latest_version: '1.1.0',
    update_type: 'minor',
    release_notes: [],
    advisories: [],
    signals: emptySignals(),
    requirements: { ...emptyRequirements(), node: REQUIRED_NODE },
    status: 'ok',
    ...over,
  };
}

function profile(node: string | null): ProjectProfile {
  return {
    product_type: 'business_app',
    users_and_scale: 'internal',
    tech_taste: 'mainstream',
    hard_constraints: { node, browser_support: null, a11y: null, compliance: [] },
    current_pain_points: [],
    upgrade_policy: { major: 'normal_queue', minor: 'normal_queue', patch: 'normal_queue' },
  };
}

function setup(profileText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-node-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack({ enginesNode: '>=20' })));
  writeFileSync(join(dir, '.stack-radar', 'updates.json'), JSON.stringify([record()]));
  writeFileSync(join(dir, '.stack-radar', 'project-profile.yaml'), profileText);
  return dir;
}

const REVIEWED_PROFILE = [
  'product_type: business_app',
  'users_and_scale: internal',
  'tech_taste: mainstream',
  'hard_constraints:',
  '  node: "24.x"',
  '',
].join('\n');

const UNREVIEWED_PROFILE = [
  'product_type: business_app # NEEDS REVIEW',
  'users_and_scale: internal',
  'tech_taste: mainstream',
  'hard_constraints:',
  '  node: "24.x"',
  '',
].join('\n');

describe('resolveProjectNode', () => {
  it('uses reviewed profile node before .nvmrc and engines.node', () => {
    expect(resolveProjectNode({ profileNode: '24.x', reviewed: true, nvmrc: '20', enginesNode: '>=18' })).toBe('24.x');
  });

  it('ignores an unreviewed profile node and falls back to .nvmrc', () => {
    expect(resolveProjectNode({ profileNode: '24.x', reviewed: false, nvmrc: '20', enginesNode: '>=18' })).toBe('20.x');
  });

  it('uses .nvmrc when there is no profile node', () => {
    expect(resolveProjectNode({ profileNode: null, reviewed: false, nvmrc: 'v24', enginesNode: '>=20' })).toBe('24.x');
  });

  it('falls back to engines.node when .nvmrc is absent or invalid', () => {
    expect(resolveProjectNode({ profileNode: null, reviewed: false, nvmrc: null, enginesNode: '>=20' })).toBe('>=20');
    expect(resolveProjectNode({ profileNode: null, reviewed: false, nvmrc: 'lts/iron', enginesNode: '>=20' })).toBe('>=20');
  });

  it('returns null when every source is absent', () => {
    expect(resolveProjectNode({ profileNode: null, reviewed: false, nvmrc: null, enginesNode: null })).toBeNull();
  });
});

describe('nodeEngineDivergenceNote', () => {
  it('warns when engines.node allows versions below the authoritative project Node', () => {
    const note = nodeEngineDivergenceNote('>=20', '24.x');
    expect(note).not.toBeNull();
    expect(note).toContain('>=20');
    expect(note).toContain('24.x');
  });

  it('does not warn when the engines floor is equal to or above the project floor', () => {
    expect(nodeEngineDivergenceNote('>=24', '24.x')).toBeNull();
    expect(nodeEngineDivergenceNote('24.x', '24.x')).toBeNull();
  });

  it('warns for multi-part ranges whose minimum is below the project floor', () => {
    const note = nodeEngineDivergenceNote('^20.19.0 || >=22.12.0', '24.x');
    expect(note).not.toBeNull();
    expect(note).toContain('^20.19.0 || >=22.12.0');
    expect(note).toContain('24.x');
  });

  it('returns null for missing or unparseable inputs', () => {
    expect(nodeEngineDivergenceNote(null, '24.x')).toBeNull();
    expect(nodeEngineDivergenceNote('>=20', null)).toBeNull();
    expect(nodeEngineDivergenceNote('lts/iron', '24.x')).toBeNull();
    expect(nodeEngineDivergenceNote('>=20', 'lts/iron')).toBeNull();
  });
});

describe('project Node precedence in scoring', () => {
  it('lets a reviewed profile node relax a stale engines.node block', () => {
    const s = stack({ enginesNode: '>=20' });
    const r = record();

    expect(evaluateBlocked(r.requirements, ['.'], buildProjectContext(s)).blocked).toBe(true);

    const ctx = buildProjectContext(s, { profileNode: '24.x', reviewed: true });
    const scored = scoreRecord(r, ctx, profile('24.x'));
    expect(ctx.nodeEngine).toBe('24.x');
    expect(scored.recommendation).not.toBe('Blocked');
  });

  it('does not let an unreviewed profile node override engines.node', () => {
    const ctx = buildProjectContext(stack({ enginesNode: '>=20' }), { profileNode: '24.x', reviewed: false });
    const scored = scoreRecord(record(), ctx, profile('24.x'));
    expect(ctx.nodeEngine).toBe('>=20');
    expect(scored.recommendation).toBe('Blocked');
  });

  it('uses .nvmrc when no profile node is authoritative', () => {
    const ctx = buildProjectContext(stack({ enginesNode: '>=20', nvmrc: '24' }));
    const scored = scoreRecord(record(), ctx);
    expect(ctx.nodeEngine).toBe('24.x');
    expect(scored.recommendation).not.toBe('Blocked');
  });

  it('preserves the engines.node fallback when there is no profile node or .nvmrc', () => {
    const ctx = buildProjectContext(stack({ enginesNode: '>=20' }));
    const scored = scoreRecord(record(), ctx);
    expect(ctx.nodeEngine).toBe('>=20');
    expect(scored.recommendation).toBe('Blocked');
  });
});

describe('runRecommend project Node precedence', () => {
  it('passes reviewed profile node into project context', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = setup(REVIEWED_PROFILE);
    try {
      await runRecommend({ repo: dir, date: '2026-06-02', out: join(dir, 'r.md') });
      expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain('- **Recommendation:** Safe to Upgrade');
      expect(err.mock.calls.flat().join('\n')).toContain('allows Node versions below');
    } finally {
      err.mockRestore();
    }
  });

  it('does not pass unreviewed profile node as authoritative', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = setup(UNREVIEWED_PROFILE);
      await runRecommend({ repo: dir, date: '2026-06-02', out: join(dir, 'r.md') });
      expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain('- **Recommendation:** Blocked');
    } finally {
      err.mockRestore();
    }
  });
});
