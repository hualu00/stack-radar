import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFeedback } from '../src/commands/feedback.js';
import { runRecommend } from '../src/commands/recommend.js';
import type { Decision } from '../src/types/decision.js';
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
    instances: [{ workspace: '.', current_range: '^18', dependency_type: 'dependencies' }],
    locked_version: '18.3.1',
    latest_version: '19.0.0',
    update_type: 'minor',
    release_notes: [{ version: '19.0.0', url: 'https://gh/19', source: 'github_release', confidence: 'high' }],
    advisories: [],
    signals: emptySignals(),
    requirements: emptyRequirements(),
    status: 'ok',
    ...over,
  };
}

function setup(updates: UpdateRecord[], decisions?: Decision[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-recdec-'));
  mkdirSync(join(dir, '.stack-radar'), { recursive: true });
  writeFileSync(join(dir, '.stack-radar', 'stack.json'), JSON.stringify(stack));
  writeFileSync(join(dir, '.stack-radar', 'updates.json'), JSON.stringify(updates));
  if (decisions) writeFileSync(join(dir, '.stack-radar', 'decisions.json'), JSON.stringify({ version: 1, decisions }));
  return dir;
}

const AT = '2026-05-20T10:00:00.000Z';
const DATE = '2026-05-27';

async function report(dir: string): Promise<string> {
  const out = join(dir, `r-${Math.random().toString(36).slice(2)}.md`);
  await runRecommend({ repo: dir, date: DATE, out });
  return readFileSync(out, 'utf8');
}

describe('recommend + decisions (M7)', () => {
  it('an active snooze hides the item from sections but labels it in the appendix; a re-run stays hidden', async () => {
    const dir = setup([rec('react')], [{ package: 'react', action: 'snooze', until: '2026-12-31', created_at: AT }]);
    const md1 = await report(dir);
    expect(md1).not.toContain('### react:'); // no item heading anywhere in the sections
    expect(md1).toContain('snoozed until 2026-12-31'); // appendix row
    expect(await report(dir)).toBe(md1); // deterministic across re-runs
  });

  it('an expired snooze resurfaces the item', async () => {
    const dir = setup([rec('react')], [{ package: 'react', action: 'snooze', until: '2026-01-01', created_at: AT }]);
    expect(await report(dir)).toContain('### react:');
  });

  it('accept keeps the item and renders a "previously accepted" marker', async () => {
    const dir = setup([rec('react')], [{ package: 'react', action: 'accept', reason: 'rolled out in v19', created_at: AT }]);
    const md = await report(dir);
    expect(md).toContain('### react:');
    expect(md).toContain('- **Decision:** previously accepted (reason: rolled out in v19)');
  });

  it('a non-security decline de-emphasizes the item to Watch with a marker', async () => {
    const dir = setup([rec('react')], [{ package: 'react', action: 'decline', reason: 'waiting on migration', created_at: AT }]);
    const md = await report(dir);
    expect(md).toContain('- **Recommendation:** Watch');
    expect(md).toContain('- **Decision:** previously declined (reason: waiting on migration)');
  });

  it('a declined item resurfaces (recommendation preserved) when the version carries a security advisory', async () => {
    const secure = rec('react', {
      signals: { ...emptySignals(), security: true },
      advisories: [{ id: 'GHSA-x', source: 'osv', summary: 'XSS' }],
    });
    const dir = setup([secure], [{ package: 'react', action: 'decline', created_at: AT }]);
    const md = await report(dir);
    expect(md).toContain('- **Recommendation:** Upgrade Now'); // security override preserves the urgent rec
    expect(md).toContain('shown anyway: this version carries a security advisory');
  });

  it('a version_range decline does not touch a different major', async () => {
    const dir = setup([rec('react', { latest_version: '20.0.0', update_type: 'major' })], [
      { package: 'react', action: 'decline', version_range: '19.x', created_at: AT },
    ]);
    expect(await report(dir)).not.toContain('previously declined'); // 19.x decision, latest is 20
  });

  it('a report with no decisions carries no decision markers', async () => {
    const md = await report(setup([rec('react')]));
    expect(md).not.toContain('**Decision:**');
    expect(md).not.toContain('snoozed until');
  });

  it('--use-ai with every scorable snoozed does not require an API key (nothing to analyze)', async () => {
    const dir = setup([rec('react')], [{ package: 'react', action: 'snooze', until: '2026-12-31', created_at: AT }]);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const out = join(dir, 'r.md');
    try {
      // No aiClient injected + no key: would throw if runAi tried to build a client.
      await expect(runRecommend({ repo: dir, date: DATE, useAi: true, out })).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('snoozed until 2026-12-31');
    expect(md).toContain('Analyzed: 0');
  });

  it('two aliases sharing name+locked but different resolved_name get independent appendix rows', async () => {
    const a = rec('foo', { resolved_name: 'pkg-a', locked_version: '1.0.0', latest_version: '2.0.0' });
    const b = rec('foo', { resolved_name: 'pkg-b', locked_version: '1.0.0', latest_version: '3.0.0' });
    const dir = setup([a, b], [{ package: 'pkg-a', action: 'decline', created_at: AT }]);
    const md = await report(dir);
    // Only the pkg-a alias (latest 2.0.0) is declined → Watch in its appendix row;
    // the pkg-b alias (latest 3.0.0) keeps its own recommendation. A name@@locked
    // key would have collapsed both rows onto one record.
    expect(md).toMatch(/\| foo \| 1\.0\.0 \| 2\.0\.0 \|[^\n]*Watch/);
    expect(md).not.toMatch(/\| foo \| 1\.0\.0 \| 3\.0\.0 \|[^\n]*Watch/);
  });

  it('end-to-end: a bare accept supersedes an active snooze, making the item visible again (EXECUTION_GUIDE flow)', async () => {
    const dir = setup([rec('react')]);
    runFeedback({ repo: dir, package: 'react', action: 'snooze', until: '2026-12-31', now: AT });
    expect(await report(dir)).not.toContain('### react:'); // snoozed → hidden

    runFeedback({ repo: dir, package: 'react', action: 'accept', now: '2026-05-21T10:00:00.000Z' });
    const md = await report(dir);
    expect(md).toContain('### react:'); // accept superseded the snooze → visible
    expect(md).toContain('- **Decision:** previously accepted');
  });
});
