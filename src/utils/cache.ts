import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Namespaced file cache under `.stack-radar/cache/<namespace>/`. Stores only
 * public data (registry packuments, releases, advisories). Cache-first reads
 * give the determinism + speed that PLAN §5 requires on repeat runs. Writes are
 * atomic (temp file + rename) so concurrent writers never leave half-written JSON.
 */
export class Cache {
  constructor(private readonly baseDir: string) {}

  private filePath(namespace: string, key: string, ext: string): string {
    // encodeURIComponent keeps the key filesystem-safe and collision-free
    // (e.g. "@scope/pkg" -> "%40scope%2Fpkg").
    return join(this.baseDir, namespace, `${encodeURIComponent(key)}.${ext}`);
  }

  readJson<T>(namespace: string, key: string): T | null {
    return this.read(namespace, key, 'json', (text) => JSON.parse(text) as T);
  }

  readText(namespace: string, key: string): string | null {
    return this.read(namespace, key, 'txt', (text) => text);
  }

  writeJson(namespace: string, key: string, data: unknown): void {
    this.write(namespace, key, 'json', JSON.stringify(data));
  }

  writeText(namespace: string, key: string, text: string): void {
    this.write(namespace, key, 'txt', text);
  }

  private read<T>(namespace: string, key: string, ext: string, parse: (text: string) => T): T | null {
    try {
      return parse(readFileSync(this.filePath(namespace, key, ext), 'utf8'));
    } catch {
      return null;
    }
  }

  private write(namespace: string, key: string, ext: string, contents: string): void {
    const path = this.filePath(namespace, key, ext);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, path);
  }
}
