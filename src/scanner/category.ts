import type { Category } from '../types/stack.js';

/**
 * Exact package-name → category mapping. Covers the common frontend ecosystem;
 * anything unmatched falls through to heuristics, then 'unknown'.
 */
const EXACT: Record<string, Category> = {
  // framework / meta-framework
  react: 'framework',
  'react-dom': 'framework',
  vue: 'framework',
  svelte: 'framework',
  '@angular/core': 'framework',
  next: 'framework',
  nuxt: 'framework',
  '@remix-run/react': 'framework',
  'solid-js': 'framework',
  preact: 'framework',
  astro: 'framework',
  '@sveltejs/kit': 'framework',

  // bundler
  vite: 'bundler',
  webpack: 'bundler',
  rollup: 'bundler',
  '@rspack/core': 'bundler',
  esbuild: 'bundler',
  parcel: 'bundler',
  '@parcel/core': 'bundler',

  // compiler
  typescript: 'compiler',
  '@babel/core': 'compiler',
  '@swc/core': 'compiler',
  sucrase: 'compiler',

  // linter
  eslint: 'linter',

  // formatter
  prettier: 'formatter',
  '@biomejs/biome': 'formatter',

  // test
  vitest: 'test',
  jest: 'test',
  '@playwright/test': 'test',
  playwright: 'test',
  cypress: 'test',
  mocha: 'test',
  '@testing-library/react': 'test',
  '@testing-library/dom': 'test',

  // state
  redux: 'state',
  '@reduxjs/toolkit': 'state',
  zustand: 'state',
  jotai: 'state',
  recoil: 'state',
  mobx: 'state',
  valtio: 'state',

  // routing
  'react-router': 'routing',
  'react-router-dom': 'routing',
  '@tanstack/react-router': 'routing',
  'vue-router': 'routing',

  // ui-lib
  '@mui/material': 'ui-lib',
  antd: 'ui-lib',
  '@chakra-ui/react': 'ui-lib',
  '@radix-ui/react-dialog': 'ui-lib',

  // data-fetching
  '@tanstack/react-query': 'data-fetching',
  '@tanstack/query-core': 'data-fetching',
  swr: 'data-fetching',
  axios: 'data-fetching',
  '@apollo/client': 'data-fetching',
  'graphql-request': 'data-fetching',

  // monorepo
  turbo: 'monorepo',
  nx: 'monorepo',
  lerna: 'monorepo',

  // runtime
  '@types/node': 'runtime',

  // utility
  lodash: 'utility',
  'date-fns': 'utility',
  dayjs: 'utility',
  zod: 'utility',
  rxjs: 'utility',
  commander: 'utility',
  yargs: 'utility',
};

/** Name-pattern heuristics, applied only when EXACT has no entry. */
function heuristic(name: string): Category {
  if (name.startsWith('@types/')) return 'utility';
  if (name.startsWith('@actions/')) return 'ci';
  if (
    name.startsWith('eslint-plugin-') ||
    name.startsWith('eslint-config-') ||
    name.startsWith('@typescript-eslint/') ||
    name.includes('eslint-config') ||
    name.includes('eslint-plugin')
  ) {
    return 'linter';
  }
  if (name.startsWith('vite-plugin-') || name.startsWith('@vitejs/')) return 'build-plugin';
  if (name.startsWith('rollup-plugin-') || name.startsWith('@rollup/plugin-')) return 'build-plugin';
  if (name.startsWith('@swc/plugin-')) return 'build-plugin';
  if (name.startsWith('babel-plugin-') || name.startsWith('@babel/plugin-') || name.startsWith('@babel/preset-')) {
    return 'build-plugin';
  }
  if (name.startsWith('@nx/') || name.startsWith('@nrwl/')) return 'monorepo';
  if (name.endsWith('-loader') || name.endsWith('-webpack-plugin')) return 'build-plugin';
  return 'unknown';
}

export function getCategory(name: string): Category {
  return EXACT[name] ?? heuristic(name);
}
