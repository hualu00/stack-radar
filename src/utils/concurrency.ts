/**
 * Map over `items` running at most `limit` tasks concurrently, preserving input
 * order in the results. Keeps network fan-out polite and bounded.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}
