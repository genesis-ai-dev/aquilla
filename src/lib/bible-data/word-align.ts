// Word alignment for the Bible data bridges (AQU-1694).
//
// IBM Model 1 trained in both directions, with a NULL word and a diagonal
// prior inside EM (the fast_align recipe), decoded with grow-diag-final-and.
// A link's confidence is the geometric mean of its two posteriors: the chance
// that this target token came from this source word, and the chance that this
// source word went to this target token. Measured on John against Clear's
// manual SBLGNT→BSB alignment, that number is calibrated (precision rises with
// it), which is what lets Who's Who draw a tint solid or dotted by confidence;
// see scripts/bridge-align-eval.ts for the measurement.
//
// Why not completion/interlinear.ts: its EM normalizes each SOURCE word's
// counts over the target sentence, so a source word never competes with its
// neighbours for a target word. On the same measurement it found a correct
// link for 44% of John's Who's Who mention words (this: 81%), and its
// confidence did not track precision: its mention links at confidence ≥ 0.7
// were right 58% of the time, against 70% at ≥ 0.1. It also costs more: on
// John, 0.5 s and up to ~120 MB of heap against 0.1 s and ~25 MB here; on the
// whole New Testament, 5.9 s and ~730 MB against 0.8 s and ~80 MB (Node 22).
// interlinear.ts stays as it is for the interlinear panel.
//
// Pure and synchronous. Training is cancellable between EM passes and reports
// progress, so a Web Worker can run it (bridge-align.worker.ts).

/** One training pair: a verse (or cell) as source tokens and target tokens. */
export interface AlignPair {
  src: readonly string[]
  tgt: readonly string[]
}

export interface WordAlignOptions {
  /** EM passes; each trains both directions. */
  iterations?: number
  /** Diagonal prior tension: higher keeps links nearer the diagonal. */
  lambda?: number
  /** Prior weight of the NULL word (a target token with no source word). */
  nullProb?: number
  /** Called after each direction of each pass: (done, total). */
  onProgress?: (done: number, total: number) => void
  /** Checked between passes; true stops training and returns null. */
  shouldStop?: () => boolean
}

/** A link between source token `src` and target token `tgt`, both 0-based token indexes. */
export interface AlignLink {
  src: number
  tgt: number
  /** In [0, 1]: the geometric mean of the forward and backward posteriors. */
  conf: number
}

/** Links below this confidence are dropped: on John they were right 28% of the time (pronouns: 20%). */
export const ALIGN_LINK_MIN = 0.1

export const DEFAULT_WORD_ALIGN: Required<Pick<WordAlignOptions, "iterations" | "lambda" | "nullProb">> = {
  iterations: 4,
  lambda: 4,
  nullProb: 0.08,
}

/** Opaque: read it through `alignWords` only. */
export interface WordAlignModel {
  readonly srcVocab: ReadonlyMap<string, number>
  readonly tgtVocab: ReadonlyMap<string, number>
  /** (source id, target id) → entry index into fwd/bwd. */
  readonly entryOf: ReadonlyMap<number, number>
  /** P(target | source) per entry. */
  readonly fwd: Float64Array
  /** P(source | target) per entry. */
  readonly bwd: Float64Array
  readonly lambda: number
  readonly nullProb: number
}

const NULL_ID = 0
// Packs a (source id, target id) pair into one number key; target ids stay below 2^22.
const KEY_STRIDE = 4_194_304

function prior(i: number, m: number, j: number, l: number, lambda: number): number {
  return Math.exp(-lambda * Math.abs((i + 0.5) / m - (j + 0.5) / l))
}

/** Train on verse pairs. Returns null when `shouldStop` asked to stop. */
export function trainWordAlignModel(pairs: readonly AlignPair[], options: WordAlignOptions = {}): WordAlignModel | null {
  const iterations = options.iterations ?? DEFAULT_WORD_ALIGN.iterations
  const lambda = options.lambda ?? DEFAULT_WORD_ALIGN.lambda
  const p0 = options.nullProb ?? DEFAULT_WORD_ALIGN.nullProb
  const srcVocab = new Map<string, number>([["", NULL_ID]])
  const tgtVocab = new Map<string, number>([["", NULL_ID]])
  const idIn = (vocab: Map<string, number>, word: string): number => {
    let id = vocab.get(word)
    if (id === undefined) vocab.set(word, (id = vocab.size))
    return id
  }
  const entryOf = new Map<number, number>()
  const srcOfEntry: number[] = []
  const tgtOfEntry: number[] = []
  const entry = (s: number, t: number): number => {
    const key = s * KEY_STRIDE + t
    let e = entryOf.get(key)
    if (e === undefined) {
      e = srcOfEntry.length
      entryOf.set(key, e)
      srcOfEntry.push(s)
      tgtOfEntry.push(t)
    }
    return e
  }

  // Each pair keeps its (i, j) → entry grid and its NULL entries, so EM runs over flat arrays.
  const grids: Int32Array[] = []
  const nullTgt: Int32Array[] = []
  const nullSrc: Int32Array[] = []
  const sizes: [number, number][] = []
  for (const pair of pairs) {
    if (pair.src.length === 0 || pair.tgt.length === 0) continue
    const s = pair.src.map((word) => idIn(srcVocab, word))
    const t = pair.tgt.map((word) => idIn(tgtVocab, word))
    const grid = new Int32Array(s.length * t.length)
    for (let i = 0; i < s.length; i++) for (let j = 0; j < t.length; j++) grid[i * t.length + j] = entry(s[i], t[j])
    grids.push(grid)
    nullTgt.push(Int32Array.from(t, (tj) => entry(NULL_ID, tj)))
    nullSrc.push(Int32Array.from(s, (si) => entry(si, NULL_ID)))
    sizes.push([s.length, t.length])
  }

  const n = srcOfEntry.length
  const fwd = new Float64Array(n).fill(1)
  const bwd = new Float64Array(n).fill(1)
  const counts = new Float64Array(n)
  const srcTotals = new Float64Array(srcVocab.size)
  const tgtTotals = new Float64Array(tgtVocab.size)
  const total = iterations * 2
  let done = 0

  for (let pass = 0; pass < iterations; pass++) {
    if (options.shouldStop?.()) return null
    // Forward: each target token was produced by one source word, or by NULL.
    counts.fill(0)
    for (let k = 0; k < grids.length; k++) {
      const grid = grids[k]
      const [m, l] = sizes[k]
      for (let j = 0; j < l; j++) {
        const nullEntry = nullTgt[k][j]
        let z = p0 * fwd[nullEntry]
        for (let i = 0; i < m; i++) z += (1 - p0) * fwd[grid[i * l + j]] * prior(i, m, j, l, lambda)
        if (z === 0) continue
        counts[nullEntry] += (p0 * fwd[nullEntry]) / z
        for (let i = 0; i < m; i++) {
          const e = grid[i * l + j]
          counts[e] += ((1 - p0) * fwd[e] * prior(i, m, j, l, lambda)) / z
        }
      }
    }
    srcTotals.fill(0)
    for (let e = 0; e < n; e++) srcTotals[srcOfEntry[e]] += counts[e]
    for (let e = 0; e < n; e++) fwd[e] = srcTotals[srcOfEntry[e]] > 0 ? counts[e] / srcTotals[srcOfEntry[e]] : 0
    options.onProgress?.(++done, total)
    if (options.shouldStop?.()) return null

    // Backward: each source word went to one target token, or to NULL.
    counts.fill(0)
    for (let k = 0; k < grids.length; k++) {
      const grid = grids[k]
      const [m, l] = sizes[k]
      for (let i = 0; i < m; i++) {
        const nullEntry = nullSrc[k][i]
        let z = p0 * bwd[nullEntry]
        for (let j = 0; j < l; j++) z += (1 - p0) * bwd[grid[i * l + j]] * prior(i, m, j, l, lambda)
        if (z === 0) continue
        counts[nullEntry] += (p0 * bwd[nullEntry]) / z
        for (let j = 0; j < l; j++) {
          const e = grid[i * l + j]
          counts[e] += ((1 - p0) * bwd[e] * prior(i, m, j, l, lambda)) / z
        }
      }
    }
    tgtTotals.fill(0)
    for (let e = 0; e < n; e++) tgtTotals[tgtOfEntry[e]] += counts[e]
    for (let e = 0; e < n; e++) bwd[e] = tgtTotals[tgtOfEntry[e]] > 0 ? counts[e] / tgtTotals[tgtOfEntry[e]] : 0
    options.onProgress?.(++done, total)
  }
  return { srcVocab, tgtVocab, entryOf, fwd, bwd, lambda, nullProb: p0 }
}

function tableValue(model: WordAlignModel, table: Float64Array, s: number | undefined, t: number | undefined): number {
  if (s === undefined || t === undefined) return 0
  const e = model.entryOf.get(s * KEY_STRIDE + t)
  return e === undefined ? 0 : table[e]
}

/** Forward and backward posteriors for one pair, as m × l grids (row = source word). */
function posteriors(model: WordAlignModel, src: readonly string[], tgt: readonly string[]) {
  const m = src.length
  const l = tgt.length
  const p0 = model.nullProb
  const s = src.map((word) => model.srcVocab.get(word))
  const t = tgt.map((word) => model.tgtVocab.get(word))
  const fwdPost = new Float64Array(m * l)
  const bwdPost = new Float64Array(m * l)
  for (let j = 0; j < l; j++) {
    let z = p0 * Math.max(tableValue(model, model.fwd, NULL_ID, t[j]), 1e-6)
    for (let i = 0; i < m; i++) {
      const w = (1 - p0) * tableValue(model, model.fwd, s[i], t[j]) * prior(i, m, j, l, model.lambda)
      fwdPost[i * l + j] = w
      z += w
    }
    for (let i = 0; i < m; i++) fwdPost[i * l + j] /= z
  }
  for (let i = 0; i < m; i++) {
    let z = p0 * Math.max(tableValue(model, model.bwd, s[i], NULL_ID), 1e-6)
    for (let j = 0; j < l; j++) {
      const w = (1 - p0) * tableValue(model, model.bwd, s[i], t[j]) * prior(i, m, j, l, model.lambda)
      bwdPost[i * l + j] = w
      z += w
    }
    for (let j = 0; j < l; j++) bwdPost[i * l + j] /= z
  }
  return { fwdPost, bwdPost, m, l }
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, 0], [0, -1], [1, 0], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
]

/**
 * Links for one pair: each direction's best guess per token (when it beats
 * NULL), kept where both agree, grown into agreeing neighbours, then any
 * remaining guess that joins two otherwise unlinked tokens (grow-diag-final-and).
 * Only links at or above `min` confidence are returned, sorted by source then target.
 */
export function alignWords(
  model: WordAlignModel,
  src: readonly string[],
  tgt: readonly string[],
  min: number = ALIGN_LINK_MIN,
): AlignLink[] {
  if (src.length === 0 || tgt.length === 0) return []
  const { fwdPost, bwdPost, m, l } = posteriors(model, src, tgt)
  const forward = new Set<number>()
  for (let j = 0; j < l; j++) {
    let best = -1
    let bestP = 0
    let mass = 0
    for (let i = 0; i < m; i++) {
      const p = fwdPost[i * l + j]
      mass += p
      if (p > bestP) {
        bestP = p
        best = i
      }
    }
    if (best >= 0 && bestP > 1 - mass) forward.add(best * l + j)
  }
  const backward = new Set<number>()
  for (let i = 0; i < m; i++) {
    let best = -1
    let bestP = 0
    let mass = 0
    for (let j = 0; j < l; j++) {
      const p = bwdPost[i * l + j]
      mass += p
      if (p > bestP) {
        bestP = p
        best = j
      }
    }
    if (best >= 0 && bestP > 1 - mass) backward.add(i * l + best)
  }
  const links = new Set([...forward].filter((cell) => backward.has(cell)))
  const union = new Set([...forward, ...backward])
  const srcLinked = new Set<number>()
  const tgtLinked = new Set<number>()
  for (const cell of links) {
    srcLinked.add(Math.floor(cell / l))
    tgtLinked.add(cell % l)
  }
  const add = (cell: number) => {
    links.add(cell)
    srcLinked.add(Math.floor(cell / l))
    tgtLinked.add(cell % l)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const cell of [...links]) {
      const i = Math.floor(cell / l)
      const j = cell % l
      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di
        const nj = j + dj
        if (ni < 0 || nj < 0 || ni >= m || nj >= l) continue
        const next = ni * l + nj
        if (links.has(next) || !union.has(next)) continue
        if (!srcLinked.has(ni) || !tgtLinked.has(nj)) {
          add(next)
          grew = true
        }
      }
    }
  }
  for (const cell of union) {
    if (!srcLinked.has(Math.floor(cell / l)) && !tgtLinked.has(cell % l)) add(cell)
  }
  const out: AlignLink[] = []
  for (const cell of links) {
    const conf = Math.sqrt(fwdPost[cell] * bwdPost[cell])
    if (conf >= min) out.push({ src: Math.floor(cell / l), tgt: cell % l, conf })
  }
  return out.sort((a, b) => a.src - b.src || a.tgt - b.tgt)
}
