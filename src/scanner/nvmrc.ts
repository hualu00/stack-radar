import { join } from 'node:path';
import semver from 'semver';
import { readText } from '../utils/fs.js';

export function readNvmrc(repoPath: string): string | null {
  const text = readText(join(repoPath, '.nvmrc'));
  if (text === null) return null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

export function nvmrcToRange(raw: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let candidate = trimmed.replace(/^v/, '');
  if (/^\d+$/.test(candidate)) candidate = `${candidate}.x`;
  if (/^\d+\.\d+$/.test(candidate)) candidate = `${candidate}.x`;

  return semver.validRange(candidate) === null ? null : candidate;
}
