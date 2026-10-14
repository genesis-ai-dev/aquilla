// Bounded parallelism helper.
//
// Several subsystems fan a per-item network read out over a small pool rather
// than a sequential `for … await` loop: a 66-book project otherwise pays 66
// serial round trips where the latency, not the work, dominates. The cap keeps
// that from turning into an unbounded stampede against sync-worker.

/**
 * Run `fn` over `items` with at most `concurrency` calls in flight. Results are
 * returned in INPUT order, so a caller that folds them into a map or an array
 * gets exactly what the sequential loop would have produced.
 *
 * The first rejection stops scheduling new work; calls already in flight settle
 * (their results are discarded) and that first error is rethrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let failed = false
  let failure: unknown

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        failed = true
        failure ??= err
        return
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (failed) throw failure
  return results
}
