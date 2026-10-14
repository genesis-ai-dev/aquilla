// Paired cluster bootstrap for the forecast evals: is method A's accuracy
// really different from method B's on the same held-out positions?
//
// Positions inside one verse are not independent (a verse the corpus knows
// well is easy for every method), so the resampling unit is the test VERSE:
// each resample draws as many verses as there are, with replacement, and
// recomputes (hits_A − hits_B) / positions over every position of the drawn
// verses. Both methods are scored on the same draw, so the CI is for the
// paired difference.

export interface BootstrapResult {
  /** Observed A − B, in accuracy points (0–100). */
  diff: number
  /** Percentile CI bounds, in accuracy points. */
  lo: number
  hi: number
  /** Number of verses resampled. */
  verses: number
}

/** Deterministic PRNG (mulberry32), so a rerun gives the same CI. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `verse[i]` is position i's verse; `a[i]` / `b[i]` the two methods' outcome
 * bits at that position; `bit` selects top-1 (1) or top-3 (2).
 */
export function pairedBootstrap(
  verse: readonly number[],
  a: readonly number[],
  b: readonly number[],
  bit: 1 | 2,
  { resamples = 2000, seed = 1, level = 0.95 }: { resamples?: number; seed?: number; level?: number } = {},
): BootstrapResult {
  if (verse.length !== a.length || a.length !== b.length) throw new Error("pairedBootstrap: length mismatch")
  // Per verse: [positions, A hits, B hits].
  const byVerse = new Map<number, [number, number, number]>()
  verse.forEach((v, i) => {
    const row = byVerse.get(v) ?? [0, 0, 0]
    row[0]++
    if (a[i] & bit) row[1]++
    if (b[i] & bit) row[2]++
    byVerse.set(v, row)
  })
  const rows = Array.from(byVerse.values())
  const total = rows.reduce((s, r) => s + r[0], 0)
  const diff = total > 0 ? (100 * rows.reduce((s, r) => s + r[1] - r[2], 0)) / total : 0
  if (rows.length === 0) return { diff: 0, lo: 0, hi: 0, verses: 0 }
  const random = seededRandom(seed)
  const draws: number[] = []
  for (let r = 0; r < resamples; r++) {
    let n = 0
    let d = 0
    for (let k = 0; k < rows.length; k++) {
      const row = rows[Math.floor(random() * rows.length)]
      n += row[0]
      d += row[1] - row[2]
    }
    draws.push(n > 0 ? (100 * d) / n : 0)
  }
  draws.sort((x, y) => x - y)
  const tail = (1 - level) / 2
  const at = (q: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))]
  return { diff, lo: at(tail), hi: at(1 - tail), verses: rows.length }
}

/** "real" when the CI excludes 0, else "noise". */
export function verdict({ lo, hi }: BootstrapResult): "real" | "noise" {
  return lo > 0 || hi < 0 ? "real" : "noise"
}
