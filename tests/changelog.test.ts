import { describe, expect, it } from 'vitest';
import { MAX_NOTE_TEXT_CHARS, collectReleaseNotes, parseTag } from '../src/update/changelog.js';
import type { GitHubClient, GitHubRelease } from '../src/update/github.js';
import type { Fetcher } from '../src/utils/http.js';

const rel = (tag: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: tag,
  name: tag,
  body: `notes for ${tag}`,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  prerelease: false,
  draft: false,
  ...extra,
});
const fakeGithub = (releases: GitHubRelease[]): GitHubClient => ({ listReleases: async () => releases });

describe('parseTag', () => {
  it('parses v-prefix, plain, monorepo and scoped tags', () => {
    expect(parseTag('v1.2.3')).toEqual({ prefix: '', version: '1.2.3' });
    expect(parseTag('1.2.3')).toEqual({ prefix: '', version: '1.2.3' });
    expect(parseTag('react-query@5.66.0')).toEqual({ prefix: 'react-query', version: '5.66.0' });
    expect(parseTag('@tanstack/react-query@5.66.0')).toEqual({ prefix: '@tanstack/react-query', version: '5.66.0' });
    expect(parseTag('v2.0.0-beta.1').version).toBe('2.0.0-beta.1');
  });
});

describe('collectReleaseNotes', () => {
  const repo = { host: 'github' as const, owner: 'o', repo: 'r' };

  it('selects releases in (locked, latest] from GitHub at high confidence', async () => {
    const github = fakeGithub([rel('v1.0.0'), rel('v1.1.0'), rel('v1.2.0'), rel('v2.0.0')]);
    const r = await collectReleaseNotes({ repo, name: 'pkg', locked: '1.0.0', latest: '1.2.0' }, { github });
    expect(r.notes.map((n) => n.version)).toEqual(['1.2.0', '1.1.0']); // desc; excludes 1.0.0 and 2.0.0
    expect(r.notes.every((n) => n.source === 'github_release' && n.confidence === 'high')).toBe(true);
    expect(r.texts).toHaveLength(2);
  });

  it('filters monorepo releases by package name (respecting directory)', async () => {
    const github = fakeGithub([rel('@tanstack/react-query@5.66.0'), rel('@tanstack/router@1.0.0')]);
    const r = await collectReleaseNotes(
      { repo: { ...repo, directory: 'packages/react-query' }, name: '@tanstack/react-query', locked: '5.0.0', latest: '5.66.0' },
      { github },
    );
    expect(r.notes.map((n) => n.version)).toEqual(['5.66.0']);
  });

  it('falls back to CHANGELOG.md when no releases match (medium confidence)', async () => {
    const fetcher: Fetcher = async (url) => ({
      ok: url.includes('CHANGELOG.md'),
      status: url.includes('CHANGELOG.md') ? 200 : 404,
      text: async () => '# Changelog\n## 1.2.0\n- stuff',
      json: async () => ({}),
    });
    const r = await collectReleaseNotes({ repo, name: 'pkg', locked: '1.0.0', latest: '1.2.0' }, { github: fakeGithub([]), fetcher });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]?.source).toBe('changelog_md');
    expect(r.notes[0]?.confidence).toBe('medium');
    expect(r.texts[0]?.text).toContain('Changelog');
  });

  it('persists truncated note text while keeping the full body for signal scanning', async () => {
    const big = 'A'.repeat(MAX_NOTE_TEXT_CHARS + 500);
    const github = fakeGithub([
      rel('v1.1.0', { body: '  ' }), // whitespace-only → no persisted text
      rel('v1.2.0', { body: big }),
    ]);
    const r = await collectReleaseNotes({ repo, name: 'pkg', locked: '1.0.0', latest: '1.2.0' }, { github });

    const v12 = r.notes.find((n) => n.version === '1.2.0');
    expect(v12?.text).toHaveLength(MAX_NOTE_TEXT_CHARS);
    expect(v12?.text_truncated).toBe(true);

    const v11 = r.notes.find((n) => n.version === '1.1.0');
    expect(v11?.text).toBeUndefined(); // empty body → text omitted, not ""
    expect(v11?.text_truncated).toBeUndefined();

    // full body is preserved in texts (signal detection must not see truncation)
    expect(r.texts.find((t) => t.version === '1.2.0')?.text).toHaveLength(big.length);
  });

  it('persists a short note body verbatim (untruncated)', async () => {
    const r = await collectReleaseNotes({ repo, name: 'pkg', locked: '1.0.0', latest: '1.1.0' }, { github: fakeGithub([rel('v1.1.0')]) });
    expect(r.notes[0]?.text).toBe('notes for v1.1.0');
    expect(r.notes[0]?.text_truncated).toBeUndefined();
  });

  it('returns empty when there is no repo', async () => {
    const r = await collectReleaseNotes({ repo: null, name: 'pkg', locked: '1.0.0', latest: '1.2.0' }, { github: fakeGithub([]) });
    expect(r.notes).toEqual([]);
  });

  it('returns empty when neither releases nor a changelog exist', async () => {
    const fetcher: Fetcher = async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
    const r = await collectReleaseNotes({ repo, name: 'pkg', locked: '1.0.0', latest: '1.2.0' }, { github: fakeGithub([]), fetcher });
    expect(r.notes).toEqual([]);
  });
});
