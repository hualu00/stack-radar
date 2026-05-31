import { describe, expect, it } from 'vitest';
import { getCategory } from '../src/scanner/category.js';

describe('getCategory', () => {
  it('maps exact known packages', () => {
    expect(getCategory('react')).toBe('framework');
    expect(getCategory('vite')).toBe('bundler');
    expect(getCategory('typescript')).toBe('compiler');
    expect(getCategory('eslint')).toBe('linter');
    expect(getCategory('prettier')).toBe('formatter');
    expect(getCategory('vitest')).toBe('test');
    expect(getCategory('@tanstack/react-query')).toBe('data-fetching');
    expect(getCategory('turbo')).toBe('monorepo');
    expect(getCategory('@types/node')).toBe('runtime');
  });

  it('applies name heuristics when not in the exact map', () => {
    expect(getCategory('@types/react')).toBe('utility');
    expect(getCategory('eslint-plugin-import')).toBe('linter');
    expect(getCategory('@typescript-eslint/parser')).toBe('linter');
    expect(getCategory('vite-plugin-svgr')).toBe('build-plugin');
    expect(getCategory('@rollup/plugin-node-resolve')).toBe('build-plugin');
    expect(getCategory('@nx/jest')).toBe('monorepo');
    expect(getCategory('ts-loader')).toBe('build-plugin');
    expect(getCategory('@actions/core')).toBe('ci');
  });

  it('defaults to unknown', () => {
    expect(getCategory('some-random-pkg')).toBe('unknown');
    expect(getCategory('octokit')).toBe('unknown');
  });
});
