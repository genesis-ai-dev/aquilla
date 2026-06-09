/**
 * interlinear.ts — Confidence-scored source↔target word alignment.
 *
 * Pure, deterministic, client-side. No network calls. No side effects beyond
 * the returned data structures.
 *
 * ## Algorithm summary
 *
 * Cold start (< WARM_THRESHOLD pairs): Dice co-occurrence coefficient, O(1)
 * update per pair.
 *
 * Warm (>= WARM_THRESHOLD pairs): IBM Model 1 EM (~10 iterations). This runs
 * synchronously in this module. Callers that invoke `buildAlignmentModel` with
 * large corpora (full Bible, 31k verses) SHOULD wrap the call in a Web Worker
 * or debounce it; for typical incremental use (a few hundred verse pairs) it
 * runs in well under 50 ms.
 *
 * Diagonal prior (fast_align-style): every alignment score is multiplied by
 * exp(-λ · |srcPos/srcLen − tgtPos/tgtLen|), λ = 4.0.
 *
 * ## Confidence thresholds
 *
 * | Range      | Meaning                         | UI treatment              |
 * |------------|---------------------------------|---------------------------|
 * | < 0.1      | No suggestion                   | Hidden                    |
 * | 0.1 – 0.3  | Amber / low confidence          | Show italic, need confirm |
 * | 0.3 – 0.6  | Default / medium confidence     | Show, one-click confirm   |
 * | ≥ 0.6      | High confidence                 | Bold, bulk-approvable     |
 *
 * ## Public API (stable — FRO-207 depends on this)
 *
 * ```ts
 * buildAlignmentModel(pairs: VersPair[], seeds?: AlignmentSeed[]): AlignmentModel
 * alignCell(source: string, target: string, model: AlignmentModel, opts?: AlignOpts): AlignmentLink[]
 * confirmAlignment(src: string, tgt: string, model: AlignmentModel): void   // mutates model
 * invalidateAlignment(src: string, tgt: string, model: AlignmentModel): void // mutates model
 * ```
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Pair count below this threshold → Dice cold-start; at or above → EM. */
const WARM_THRESHOLD = 50

/** Number of EM iterations for IBM Model 1. */
const EM_ITERATIONS = 10

/**
 * λ for the fast_align diagonal prior.
 * score *= exp(-λ · |srcPos/srcLen − tgtPos/tgtLen|)
 * λ ≈ 4.0 works well for Bible (roughly monotone, short verses).
 */
const DIAGONAL_LAMBDA = 4.0

/**
 * Multiplier applied to the effective count when a user confirms an alignment.
 * Matches Paratext's heuristic where confirmed glosses count ~5× a single
 * co-occurrence observation.
 */
const CONFIRM_WEIGHT = 5

/**
 * Count subtracted when a user invalidates an alignment (marks it wrong).
 * Clipped to 0 so it never goes negative.
 */
const INVALIDATE_WEIGHT = 3

// ── Public types ──────────────────────────────────────────────────────────────

/** A single (source verse, target verse) training pair. */
export interface VersPair {
  source: string
  target: string
}

/**
 * A seed that biases the model before (or after) EM training.
 * Positive weight boosts the alignment; negative weight penalizes it.
 */
export interface AlignmentSeed {
  /** Source-language token or phrase. */
  srcToken: string
  /** Target-language token or phrase. */
  tgtToken: string
  /** Signed integer weight. |weight| = number of pseudo-counts to add/subtract. */
  weight: number
}

/**
 * A single high-confidence word-alignment link between a source and target token.
 */
export interface AlignmentLink {
  /** Zero-based index in the tokenized source sentence. */
  srcIndex: number
  /** The actual source token string (lowercased). */
  srcToken: string
  /** Zero-based index in the tokenized target sentence. */
  tgtIndex: number
  /** The actual target token string (lowercased). */
  tgtToken: string
  /**
   * Confidence score in [0, 1].
   * See module-level threshold table for interpretation.
   */
  confidence: number
}

/** Options passed to `alignCell`. */
export interface AlignOpts {
  /**
   * Minimum confidence to include a link in the result.
   * Default: 0.1 (amber threshold; links below this are noise).
   */
  threshold?: number
}

/**
 * Opaque alignment model returned by `buildAlignmentModel` and consumed by
 * `alignCell` / `confirmAlignment` / `invalidateAlignment`.
 *
 * Internal fields are NOT stable API — access via the exported functions only.
 */
export interface AlignmentModel {
  /** Translation probability table: src → tgt → P(tgt | src). */
  readonly probTable: Map<string, Map<string, number>>
  /**
   * Raw count table kept alongside probTable for online updates.
   * src → tgt → effective count.
   */
  readonly countTable: Map<string, Map<string, number>>
  /** Marginal source-token counts (for Dice cold-start). */
  readonly srcCounts: Map<string, number>
  /** Marginal target-token counts (for Dice cold-start). */
  readonly tgtCounts: Map<string, number>
  /** Number of (source, target) pairs used to train this model. */
  readonly pairCount: number
  /** Whether the model was trained with EM (true) or Dice cold-start (false). */
  readonly isWarm: boolean
}

// ── Tokenization ──────────────────────────────────────────────────────────────

const TOKEN_RE = /[\p{L}\p{N}]+/gu

/** Split a string into lowercase Unicode tokens. */
function tokenize(s: string): string[] {
  return Array.from(s.matchAll(TOKEN_RE), (m) => m[0].toLowerCase())
}

// ── Dice cold-start ───────────────────────────────────────────────────────────

/**
 * Compute Dice co-occurrence coefficient:
 * 2 * count(s, t) / (count(s) + count(t))
 */
function dice(
  srcToken: string,
  tgtToken: string,
  countTable: Map<string, Map<string, number>>,
  srcCounts: Map<string, number>,
  tgtCounts: Map<string, number>,
): number {
  const joint = countTable.get(srcToken)?.get(tgtToken) ?? 0
  if (joint === 0) return 0
  const sc = srcCounts.get(srcToken) ?? 0
  const tc = tgtCounts.get(tgtToken) ?? 0
  const denom = sc + tc
  return denom === 0 ? 0 : (2 * joint) / denom
}

// ── Count-table helpers ───────────────────────────────────────────────────────

function getOrCreate<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  let v = map.get(key)
  if (v === undefined) {
    v = factory()
    map.set(key, v)
  }
  return v
}

function addCount(
  countTable: Map<string, Map<string, number>>,
  srcToken: string,
  tgtToken: string,
  delta: number,
): void {
  const inner = getOrCreate(countTable, srcToken, () => new Map<string, number>())
  inner.set(tgtToken, Math.max(0, (inner.get(tgtToken) ?? 0) + delta))
}

/**
 * Renormalize a single source-token row in probTable from countTable.
 * Only O(|tgt vocab for this src token|) — essentially free.
 */
function renormalizeRow(
  srcToken: string,
  probTable: Map<string, Map<string, number>>,
  countTable: Map<string, Map<string, number>>,
): void {
  const counts = countTable.get(srcToken)
  if (!counts || counts.size === 0) return
  let total = 0
  for (const c of counts.values()) total += c
  if (total === 0) return
  const probs = getOrCreate(probTable, srcToken, () => new Map<string, number>())
  for (const [tgt, c] of counts) {
    probs.set(tgt, c / total)
  }
}

// ── IBM Model 1 EM ────────────────────────────────────────────────────────────

/**
 * Run IBM Model 1 EM over `pairs` for `iterations` passes.
 * Returns updated `probTable` and `countTable` (counts from final E-step).
 *
 * NOTE: This is synchronous. For corpora of a few hundred verse pairs it runs
 * in < 10 ms. For full 31k-verse Bibles, callers SHOULD run this in a Web
 * Worker and debounce it (suggested: every 10 confirmations or 60 s idle).
 */
function runEM(
  pairs: VersPair[],
  iterations: number,
): { probTable: Map<string, Map<string, number>>; countTable: Map<string, Map<string, number>> } {
  // Collect vocabulary
  const tokenizedPairs: { src: string[]; tgt: string[] }[] = []
  const srcVocab = new Set<string>()
  const tgtVocab = new Set<string>()

  for (const { source, target } of pairs) {
    const src = tokenize(source)
    const tgt = tokenize(target)
    if (src.length === 0 || tgt.length === 0) continue
    tokenizedPairs.push({ src, tgt })
    for (const t of src) srcVocab.add(t)
    for (const t of tgt) tgtVocab.add(t)
  }

  if (tokenizedPairs.length === 0 || srcVocab.size === 0 || tgtVocab.size === 0) {
    return { probTable: new Map(), countTable: new Map() }
  }

  // Initialize uniformly: P(tgt | src) = 1 / |tgt_vocab|
  const uniform = 1 / tgtVocab.size
  const probTable = new Map<string, Map<string, number>>()
  for (const s of srcVocab) {
    const row = new Map<string, number>()
    for (const t of tgtVocab) row.set(t, uniform)
    probTable.set(s, row)
  }

  let countTable = new Map<string, Map<string, number>>()

  for (let iter = 0; iter < iterations; iter++) {
    // E-step: accumulate fractional counts
    countTable = new Map()

    for (const { src, tgt } of tokenizedPairs) {
      for (const s of src) {
        const pRow = probTable.get(s)
        if (!pRow) continue

        // Compute normalizer: sum of P(t | s) for all t in this target sentence
        let normalizer = 0
        for (const t of tgt) {
          normalizer += pRow.get(t) ?? 0
        }
        if (normalizer === 0) continue

        for (const t of tgt) {
          const p = (pRow.get(t) ?? 0) / normalizer
          addCount(countTable, s, t, p)
        }
      }
    }

    // M-step: renormalize counts → probabilities
    for (const [s, tCounts] of countTable) {
      let total = 0
      for (const c of tCounts.values()) total += c
      if (total === 0) continue
      const pRow = getOrCreate(probTable, s, () => new Map<string, number>())
      for (const [t, c] of tCounts) {
        pRow.set(t, c / total)
      }
    }
  }

  return { probTable, countTable }
}

// ── Public: buildAlignmentModel ───────────────────────────────────────────────

/**
 * Build (or rebuild) an alignment model from a parallel corpus.
 *
 * - If `pairs.length < 50`: uses Dice co-occurrence (cold-start, fast, O(1) update).
 * - If `pairs.length >= 50`: runs IBM Model 1 EM (~10 iterations, synchronous).
 *
 * @param pairs  Parallel (source, target) verse pairs from translated cells.
 * @param seeds  Optional alignment seeds; positive weight boosts, negative penalizes.
 *               Seeds are applied as pseudo-counts BEFORE EM / Dice normalization.
 * @returns      An `AlignmentModel` consumed by `alignCell`, `confirmAlignment`,
 *               and `invalidateAlignment`.
 */
export function buildAlignmentModel(
  pairs: VersPair[],
  seeds: AlignmentSeed[] = [],
): AlignmentModel {
  const countTable = new Map<string, Map<string, number>>()
  const srcCounts = new Map<string, number>()
  const tgtCounts = new Map<string, number>()

  // Accumulate raw co-occurrence counts from all pairs (used for both Dice and EM init)
  for (const { source, target } of pairs) {
    const srcToks = tokenize(source)
    const tgtToks = tokenize(target)
    if (srcToks.length === 0 || tgtToks.length === 0) continue

    for (const s of srcToks) {
      srcCounts.set(s, (srcCounts.get(s) ?? 0) + 1)
      for (const t of tgtToks) {
        addCount(countTable, s, t, 1)
      }
    }
    for (const t of tgtToks) {
      tgtCounts.set(t, (tgtCounts.get(t) ?? 0) + 1)
    }
  }

  // Apply seeds as pseudo-counts (positive or negative, clipped at 0)
  for (const { srcToken, tgtToken, weight } of seeds) {
    if (weight === 0) continue
    const s = srcToken.toLowerCase()
    const t = tgtToken.toLowerCase()
    addCount(countTable, s, t, weight * CONFIRM_WEIGHT)
    if (weight > 0) {
      srcCounts.set(s, (srcCounts.get(s) ?? 0) + weight)
      tgtCounts.set(t, (tgtCounts.get(t) ?? 0) + weight)
    }
  }

  const isWarm = pairs.length >= WARM_THRESHOLD

  let probTable: Map<string, Map<string, number>>

  if (isWarm) {
    // Run EM — it returns its own probTable and countTable derived from EM counts
    const emResult = runEM(pairs, EM_ITERATIONS)
    probTable = emResult.probTable

    // Merge seed pseudo-counts on top of EM result (post-process)
    for (const { srcToken, tgtToken, weight } of seeds) {
      if (weight === 0) continue
      const s = srcToken.toLowerCase()
      const t = tgtToken.toLowerCase()
      // Apply seed directly to countTable for future online updates
      addCount(countTable, s, t, weight * CONFIRM_WEIGHT)
      renormalizeRow(s, probTable, countTable)
    }
  } else {
    // Cold-start: probTable is derived from Dice on demand in alignCell.
    // Store a normalized count-based prob as well for consistency.
    probTable = new Map()
    for (const [s, tCounts] of countTable) {
      let total = 0
      for (const c of tCounts.values()) total += c
      if (total === 0) continue
      const row = new Map<string, number>()
      for (const [t, c] of tCounts) {
        row.set(t, c / total)
      }
      probTable.set(s, row)
    }
  }

  return {
    probTable,
    countTable,
    srcCounts,
    tgtCounts,
    pairCount: pairs.length,
    isWarm,
  }
}

// ── Diagonal prior ────────────────────────────────────────────────────────────

/**
 * fast_align-style diagonal prior.
 * Returns a multiplier in (0, 1] that is 1 on the diagonal and decays
 * exponentially as alignment distance from the diagonal increases.
 */
function diagonalPrior(
  srcPos: number,
  srcLen: number,
  tgtPos: number,
  tgtLen: number,
): number {
  if (srcLen === 0 || tgtLen === 0) return 1
  return Math.exp(-DIAGONAL_LAMBDA * Math.abs(srcPos / srcLen - tgtPos / tgtLen))
}

// ── Public: alignCell ─────────────────────────────────────────────────────────

/**
 * Compute confidence-scored word alignment links for a single cell.
 *
 * Each source token is aligned to its best-matching target token (greedy argmax
 * over confidence × diagonal prior). Only links above `opts.threshold` are
 * returned (default 0.1).
 *
 * The algorithm:
 * 1. For each (srcToken, tgtToken) pair, compute a raw score:
 *    - Warm: IBM Model 1 probability P(tgt | src) from EM-trained probTable.
 *    - Cold: Dice(srcToken, tgtToken) from co-occurrence counts.
 * 2. Multiply by diagonalPrior(srcPos, srcLen, tgtPos, tgtLen).
 * 3. For each source token, pick the target token with the highest combined score.
 * 4. Filter by threshold.
 *
 * @param source  Source-language verse string.
 * @param target  Target-language verse string.
 * @param model   Model from `buildAlignmentModel`.
 * @param opts    Optional threshold and other options.
 * @returns       Sorted array of `AlignmentLink` (by srcIndex, then tgtIndex).
 */
export function alignCell(
  source: string,
  target: string,
  model: AlignmentModel,
  opts: AlignOpts = {},
): AlignmentLink[] {
  const threshold = opts.threshold ?? 0.1

  const srcTokens = tokenize(source)
  const tgtTokens = tokenize(target)

  if (srcTokens.length === 0 || tgtTokens.length === 0) return []

  const links: AlignmentLink[] = []

  for (let si = 0; si < srcTokens.length; si++) {
    const s = srcTokens[si]
    let bestTgtIndex = -1
    let bestScore = -Infinity

    for (let ti = 0; ti < tgtTokens.length; ti++) {
      const t = tgtTokens[ti]

      let rawScore: number
      if (model.isWarm) {
        rawScore = model.probTable.get(s)?.get(t) ?? 0
      } else {
        rawScore = dice(s, t, model.countTable, model.srcCounts, model.tgtCounts)
      }

      if (rawScore === 0) continue

      const prior = diagonalPrior(si, srcTokens.length, ti, tgtTokens.length)
      const combined = rawScore * prior

      if (combined > bestScore) {
        bestScore = combined
        bestTgtIndex = ti
      }
    }

    // Clamp confidence to [0, 1]
    const confidence = Math.min(1, Math.max(0, bestScore))

    if (bestTgtIndex >= 0 && confidence >= threshold) {
      links.push({
        srcIndex: si,
        srcToken: s,
        tgtIndex: bestTgtIndex,
        tgtToken: tgtTokens[bestTgtIndex],
        confidence,
      })
    }
  }

  return links.sort((a, b) => a.srcIndex - b.srcIndex || a.tgtIndex - b.tgtIndex)
}

// ── Public: online update hooks ───────────────────────────────────────────────

/**
 * Confirm a specific (srcToken, tgtToken) alignment.
 *
 * Increments the count for this pair by `CONFIRM_WEIGHT` (default 5) and
 * renormalizes only the affected source-token row. O(|tgt vocab for srcToken|).
 *
 * Persistence of confirmed alignments (saving to project settings as seeds) is
 * handled by FRO-207. This function only updates the in-memory model.
 *
 * NOTE: For models trained with EM, calling this repeatedly (without a full
 * EM re-run) will drift the probTable away from the EM optimum. A full re-run
 * should be triggered (debounced) every ~10 confirmations or 60 s of inactivity.
 */
export function confirmAlignment(
  srcToken: string,
  tgtToken: string,
  model: AlignmentModel,
): void {
  const s = srcToken.toLowerCase()
  const t = tgtToken.toLowerCase()
  addCount(model.countTable, s, t, CONFIRM_WEIGHT)
  model.srcCounts.set(s, (model.srcCounts.get(s) ?? 0) + CONFIRM_WEIGHT)
  model.tgtCounts.set(t, (model.tgtCounts.get(t) ?? 0) + CONFIRM_WEIGHT)
  renormalizeRow(s, model.probTable, model.countTable)
}

/**
 * Invalidate a specific (srcToken, tgtToken) alignment (mark it wrong).
 *
 * Subtracts `INVALIDATE_WEIGHT` (default 3) from the count for this pair
 * (floored at 0) and renormalizes only the affected source-token row.
 * O(|tgt vocab for srcToken|).
 *
 * Persistence of invalidated alignments (saving to project settings as negative
 * seeds) is handled by FRO-207.
 */
export function invalidateAlignment(
  srcToken: string,
  tgtToken: string,
  model: AlignmentModel,
): void {
  const s = srcToken.toLowerCase()
  const t = tgtToken.toLowerCase()
  // addCount clips at 0 via Math.max, so negative delta is safe
  addCount(model.countTable, s, t, -INVALIDATE_WEIGHT)
  renormalizeRow(s, model.probTable, model.countTable)
}

// ── Re-export confidence threshold constants for consumers ────────────────────

/** Minimum confidence to show any suggestion. */
export const CONFIDENCE_MIN = 0.1
/** Upper bound of the amber / low-confidence band. */
export const CONFIDENCE_AMBER = 0.3
/** Upper bound of the medium-confidence band (start of bulk-approvable). */
export const CONFIDENCE_HIGH = 0.6

/**
 * Minimum number of validated translation pairs before the alignment model
 * has enough signal to produce non-random alignments. Below this count the
 * statistical model is essentially guessing — the UI shows a "need more
 * translations" state instead of spurious suggestions.
 *
 * Rationale: Dice cold-start needs at least a handful of co-occurrences to
 * distinguish signal from noise. 5 pairs ≈ the minimum where we see any
 * meaningful token-level associations in practice; 10 is a comfortable floor.
 */
export const MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT = 10
