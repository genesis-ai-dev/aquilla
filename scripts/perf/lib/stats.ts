/**
 * Latency statistics for the AQU-1868 performance harness.
 *
 * Pure functions, no I/O: the measurement scripts collect raw per-call
 * durations and hand them here, so the summary arithmetic is unit-testable
 * without a dev stack. Percentiles are NEAREST-RANK over a sorted ascending
 * copy, matching `scripts/cost-report.ts` — one percentile convention per
 * repo, or two reports of "p95" mean two different numbers.
 */

export interface LatencySummary {
  /** Number of samples the summary was built from. */
  count: number
  minMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
  /** Wall-clock span the samples were collected over, when the caller timed it. */
  elapsedMs?: number
  /** Completed samples per second over `elapsedMs`. Absent without it. */
  throughputPerSec?: number
}

/** Nearest-rank percentile over an ascending-sorted array. Empty → 0. */
export function percentileOfSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

/** Nearest-rank percentile over unsorted samples (sorts a copy). */
export function percentile(samples: readonly number[], p: number): number {
  return percentileOfSorted([...samples].sort((a, b) => a - b), p)
}

/**
 * Summarize raw durations in ms. `elapsedMs` is the wall clock the batch took
 * — pass it for concurrent batches, where throughput is the number that moves
 * when a write path stops serializing and per-call latency alone does not.
 */
export function summarize(samples: readonly number[], elapsedMs?: number): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b)
  const count = sorted.length
  const sum = sorted.reduce((acc, n) => acc + n, 0)
  const summary: LatencySummary = {
    count,
    minMs: count === 0 ? 0 : sorted[0],
    p50Ms: percentileOfSorted(sorted, 50),
    p95Ms: percentileOfSorted(sorted, 95),
    p99Ms: percentileOfSorted(sorted, 99),
    maxMs: count === 0 ? 0 : sorted[count - 1],
    meanMs: count === 0 ? 0 : sum / count,
  }
  if (elapsedMs !== undefined) {
    summary.elapsedMs = elapsedMs
    summary.throughputPerSec = elapsedMs > 0 ? (count / elapsedMs) * 1000 : 0
  }
  return summary
}

/** Round to `digits` decimals — report numbers, not float noise. */
export function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Time one async operation. Returns the result and its duration, so callers
 * build sample arrays without a stopwatch at every call site.
 */
export async function timed<T>(op: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now()
  const value = await op()
  return { value, ms: performance.now() - started }
}

/**
 * Run `op` `total` times with at most `concurrency` in flight, collecting one
 * duration per call. This is the shape the ticket's "single-cell commit with N
 * concurrent writers" needs: the writers contend for the same project, and the
 * returned `elapsedMs` covers the whole batch.
 */
export async function runConcurrently(
  total: number,
  concurrency: number,
  op: (index: number) => Promise<unknown>,
): Promise<{ samples: number[]; elapsedMs: number; errors: string[] }> {
  const samples: number[] = []
  const errors: string[] = []
  let next = 0
  const started = performance.now()
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= total) return
      try {
        const { ms } = await timed(() => Promise.resolve(op(index)))
        samples.push(ms)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  })
  await Promise.all(workers)
  return { samples, elapsedMs: performance.now() - started, errors }
}
