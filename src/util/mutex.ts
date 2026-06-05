/**
 * A keyed async mutex. Serializes async critical sections per key so that, for
 * example, two overlapping ingests for the same user run their
 * read-diff-write sequence one at a time (review finding F10).
 *
 * SQLite is a single writer; this guards the in-process read-modify-write logic
 * (event diffing, stale flag) that spans multiple awaited DB calls.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Run fn after the previous holder settles (regardless of its outcome).
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Avoid unbounded growth: drop the entry once this is the last in line.
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
