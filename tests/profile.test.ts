import { describe, expect, it } from 'vitest';
import { ProfileError, hasUnreviewedMarkers, parseProfile } from '../src/scoring/profile.js';

const FULL = `
product_type: component_library
users_and_scale: enterprise_b2b
tech_taste: conservative
hard_constraints:
  node: ">=18"
  browser_support: "Chrome 100+, Safari 15+"
  a11y: "WCAG 2.1 AA"
  compliance:
    - SOC2
current_pain_points:
  - "build time too slow"
  - "TS type check slow"
upgrade_policy:
  major: manual_review
  minor: normal_queue
  patch: auto_candidate
`;

describe('parseProfile — valid', () => {
  it('parses a full profile', () => {
    const p = parseProfile(FULL);
    expect(p.product_type).toBe('component_library');
    expect(p.users_and_scale).toBe('enterprise_b2b');
    expect(p.tech_taste).toBe('conservative');
    expect(p.hard_constraints.node).toBe('>=18');
    expect(p.hard_constraints.browser_support).toBe('Chrome 100+, Safari 15+');
    expect(p.hard_constraints.compliance).toEqual(['SOC2']);
    expect(p.current_pain_points).toEqual(['build time too slow', 'TS type check slow']);
    expect(p.upgrade_policy).toEqual({ major: 'manual_review', minor: 'normal_queue', patch: 'auto_candidate' });
  });

  it('fills neutral defaults for omitted optional blocks', () => {
    const p = parseProfile('product_type: business_app\nusers_and_scale: internal\ntech_taste: mainstream\n');
    expect(p.hard_constraints).toEqual({ node: null, browser_support: null, a11y: null, compliance: [] });
    expect(p.current_pain_points).toEqual([]);
    expect(p.upgrade_policy).toEqual({ major: 'normal_queue', minor: 'normal_queue', patch: 'normal_queue' });
  });

  it('defaults only the missing upgrade_policy fields', () => {
    const p = parseProfile(
      'product_type: internal_tool\nusers_and_scale: internal\ntech_taste: aggressive\nupgrade_policy:\n  major: auto_candidate\n',
    );
    expect(p.upgrade_policy).toEqual({ major: 'auto_candidate', minor: 'normal_queue', patch: 'normal_queue' });
  });

  it('ignores unknown top-level keys', () => {
    const p = parseProfile('product_type: sdk\nusers_and_scale: internal\ntech_taste: mainstream\nfuture_field: 42\n');
    expect(p.product_type).toBe('sdk');
  });

  it('is deterministic (same text → equal result)', () => {
    expect(parseProfile(FULL)).toEqual(parseProfile(FULL));
  });
});

describe('parseProfile — invalid', () => {
  it('throws ProfileError on a missing required enum', () => {
    expect(() => parseProfile('users_and_scale: internal\ntech_taste: mainstream\n')).toThrow(ProfileError);
    expect(() => parseProfile('users_and_scale: internal\ntech_taste: mainstream\n')).toThrow(/product_type/);
  });

  it('throws on a bad enum value, naming the allowed set', () => {
    expect(() => parseProfile('product_type: library\nusers_and_scale: internal\ntech_taste: mainstream\n')).toThrow(
      /product_type.*component_library/s,
    );
  });

  it('throws on a non-mapping document', () => {
    expect(() => parseProfile('- a\n- b\n')).toThrow(/mapping/);
    expect(() => parseProfile('42')).toThrow(/mapping/);
  });

  it('throws on malformed YAML', () => {
    expect(() => parseProfile('product_type: [unclosed\n')).toThrow(ProfileError);
  });

  it('validates hard_constraints.node as a semver range', () => {
    const bad = 'product_type: business_app\nusers_and_scale: internal\ntech_taste: mainstream\nhard_constraints:\n  node: "node 18"\n';
    expect(() => parseProfile(bad)).toThrow(/hard_constraints.node/);
    const ok = 'product_type: business_app\nusers_and_scale: internal\ntech_taste: mainstream\nhard_constraints:\n  node: ">=20"\n';
    expect(parseProfile(ok).hard_constraints.node).toBe('>=20');
  });

  it('treats a blank node constraint as null (not a silent wildcard)', () => {
    const blank = 'product_type: business_app\nusers_and_scale: internal\ntech_taste: mainstream\nhard_constraints:\n  node: "   "\n';
    expect(parseProfile(blank).hard_constraints.node).toBeNull();
  });

  it('rejects non-string list items', () => {
    const bad = 'product_type: business_app\nusers_and_scale: internal\ntech_taste: mainstream\ncurrent_pain_points:\n  - 1\n  - 2\n';
    expect(() => parseProfile(bad)).toThrow(/current_pain_points/);
  });

  it('rejects an invalid upgrade_policy enum', () => {
    const bad = 'product_type: business_app\nusers_and_scale: internal\ntech_taste: mainstream\nupgrade_policy:\n  major: yolo\n';
    expect(() => parseProfile(bad)).toThrow(/upgrade_policy.major/);
  });
});

describe('hasUnreviewedMarkers', () => {
  it('detects init-profile review markers', () => {
    expect(hasUnreviewedMarkers('product_type: business_app # NEEDS REVIEW\n')).toBe(true);
    expect(hasUnreviewedMarkers('product_type: business_app   #needs review\n')).toBe(true);
  });
  it('returns false once markers are removed', () => {
    expect(hasUnreviewedMarkers(FULL)).toBe(false);
  });
});
