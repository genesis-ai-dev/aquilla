/**
 * interlinear.ts — Confidence-scored source↔target word alignment.
 *
 * Pure, deterministic, client-side. No network calls. No side effects beyond
 * the returned data structures.
 *
 * ## Algorithm summary
 *
 * Cold start (< WARM_THRESHOLD pairs): Dice co-occurrence coefficient, O(1)
 * update per pair, times a fast_align-style diagonal prior
 * exp(-λ · |srcPos/srcLen − tgtPos/tgtLen|), λ = 4.0.
 *
 * Warm (>= WARM_THRESHOLD pairs): `bible-data/word-align.ts` — IBM Model 1
 * trained in BOTH directions with a NULL word and the diagonal prior inside
 * EM, decoded with grow-diag-final-and. A link's score is the geometric mean
 * of its two posteriors.
 *
 * AQU-1696: the warm path used to run its own one-directional sparse EM, which
 * normalized each SOURCE word's counts over the target sentence. Source words
 * therefore never competed for a target word, and the consequence was not just
 * low recall — the confidence number was *anti*-calibrated, so the panel drew
 * its most confident suggestions least accurately. Measured on John 4 against
 * Clear-Bible's manual SBLGNT→BSB alignment (the checked-in
 * `bible-data/__fixtures__/bridge-jhn4.json`, trained on that chapter alone):
 *
 * | Measure (JHN 4 vs BSB)         | before | after |
 * | ------------------------------ | ------ | ----- |
 * | Gold links recalled            | 16.0%  | 37.0% |
 * | Source words reaching a gold target | 22.3% | 51.6% |
 * | Precision of all links         | 53.2%  | 61.3% |
 * | Precision at confidence ≥ 0.5  | 53.8%  | 67.4% |
 * | Precision at confidence ≥ 0.7  | 39.5%  | 71.9% |
 *
 * `interlinear.test.ts` holds that measurement as a regression guard.
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
 * ## Public API (stable — AQU-207 depends on this)
 *
 * ```ts
 * buildAlignmentModel(pairs: VersPair[], seeds?: AlignmentSeed[]): AlignmentModel
 * alignCell(source: string, target: string, model: AlignmentModel, opts?: AlignOpts): AlignmentLink[]
 * confirmAlignment(src: string, tgt: string, model: AlignmentModel): void   // mutates model
 * invalidateAlignment(src: string, tgt: string, model: AlignmentModel): void // mutates model
 * ```
 */

import {
  alignWords,
  forwardProbabilities,
  trainWordAlignModel,
  type WordAlignModel,
} from "@/lib/bible-data/word-align"
import { tokenize } from "./tokenize"

// ── Constants ─────────────────────────────────────────────────────────────────

/** Pair count below this threshold → Dice cold-start; at or above → EM. */
const WARM_THRESHOLD = 50

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
  /**
   * AQU-1696: the warm path's trained aligner, or null on the cold path.
   * `alignCell` scores from this when it is present.
   */
  readonly wordAlign: WordAlignModel | null
  /**
   * Signed decision weight per (srcToken, tgtToken): seeds plus everything the
   * reader has confirmed or invalidated since.
   *
   * The cold path does not read this — there, a seed or a confirmation is a
   * pseudo-count in `countTable`, which is what Dice scores from, so it already
   * competes with the corpus on equal terms. The warm path's IBM-1 tables are
   * trained rather than counted and cannot absorb a single new observation
   * cheaply, so a decision rides this layer on top of the trained score
   * instead (see `applyDecision`).
   */
  readonly decisions: Map<string, Map<string, number>>
}

// ── Tokenization ──────────────────────────────────────────────────────────────

/**
 * The tokenizer `alignCell` uses, re-exported so the panel can synthesize a row
 * for a decided (srcToken, tgtToken) pair on the same token boundaries that
 * produced the link in the first place (AQU-207).
 *
 * The rule — combining marks belong inside a word — and why it matters live in
 * `./tokenize`, which `bt-glosser.ts` shares so the gloss cannot tokenize
 * differently from the alignment it is read against (AQU-462, AQU-1190).
 */
export { tokenize }

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

// ── Warm path: two-directional IBM Model 1 (AQU-1696) ────────────────────────

/**
 * Train the warm aligner on `pairs`.
 *
 * This is `bible-data/word-align.ts`, the same aligner Who's Who uses for its
 * source→target bridge, so the interlinear panel and Who's Who now agree about
 * what a confidence of 0.6 means. It trains IBM Model 1 in both directions with
 * a NULL word and the diagonal prior inside EM, which is what makes source words
 * compete for a target word; see this module's header for the measurement.
 */
function trainWarmModel(pairs: VersPair[]): WordAlignModel | null {
  const tokenized: { src: string[]; tgt: string[] }[] = []
  for (const { source, target } of pairs) {
    const src = tokenize(source)
    const tgt = tokenize(target)
    if (src.length === 0 || tgt.length === 0) continue
    tokenized.push({ src, tgt })
  }
  if (tokenized.length === 0) return null
  return trainWordAlignModel(tokenized)
}

// ── Reader decisions on the warm path ─────────────────────────────────────────

/**
 * Fold a reader's decision about a pair into its trained score.
 *
 * A positive weight moves the score toward 1 and a negative one toward 0, by a
 * fraction that saturates as the weight grows, so one confirmation is worth a
 * lot and the tenth is worth little. The result stays in [0, 1], and the score
 * is monotone in the weight — which is the contract the panel relies on:
 * confirming a suggestion never lowers it, invalidating one never raises it.
 */
function applyDecision(base: number, weight: number): number {
  if (weight === 0) return base
  const pull = Math.abs(weight) / (Math.abs(weight) + CONFIRM_WEIGHT)
  return weight > 0 ? base + (1 - base) * pull : base * (1 - pull)
}

function addDecision(
  decisions: Map<string, Map<string, number>>,
  srcToken: string,
  tgtToken: string,
  delta: number,
): void {
  const row = getOrCreate(decisions, srcToken, () => new Map<string, number>())
  row.set(tgtToken, (row.get(tgtToken) ?? 0) + delta)
}

// ── Public: buildAlignmentModel ───────────────────────────────────────────────

/**
 * Build (or rebuild) an alignment model from a parallel corpus.
 *
 * - If `pairs.length < 50`: uses Dice co-occurrence (cold-start, fast, O(1) update).
 * - If `pairs.length >= 50`: trains `bible-data/word-align.ts` — IBM Model 1 in
 *   both directions, synchronous (AQU-1696).
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
  const decisions = new Map<string, Map<string, number>>()

  // Accumulate raw co-occurrence counts from all pairs (Dice scores from these,
  // and they stay the substrate for the online confirm/invalidate updates)
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
    addDecision(decisions, s, t, weight)
    if (weight > 0) {
      srcCounts.set(s, (srcCounts.get(s) ?? 0) + weight)
      tgtCounts.set(t, (tgtCounts.get(t) ?? 0) + weight)
    }
  }

  const isWarm = pairs.length >= WARM_THRESHOLD
  // A warm corpus whose every pair is unusable (all blank on one side) leaves
  // nothing to train on; fall back to the cold scorer rather than publish a
  // warm model that cannot answer.
  const wordAlign = isWarm ? trainWarmModel(pairs) : null

  // `terminology/equivalents.ts` reads `probTable` as a ranked row of target
  // candidates for one source term, so both paths publish one: warm from the
  // trained forward table, cold from the raw counts. `alignCell` itself does not
  // read it — it scores the cold path with Dice and the warm path with
  // `alignWords`.
  const probTable = wordAlign
    ? forwardProbabilities(wordAlign)
    : (() => {
        const table = new Map<string, Map<string, number>>()
        for (const [s, tCounts] of countTable) {
          let total = 0
          for (const c of tCounts.values()) total += c
          if (total === 0) continue
          const row = new Map<string, number>()
          for (const [t, c] of tCounts) row.set(t, c / total)
          table.set(s, row)
        }
        return table
      })()

  return {
    probTable,
    countTable,
    srcCounts,
    tgtCounts,
    pairCount: pairs.length,
    isWarm,
    wordAlign,
    decisions,
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
 * Each source token is aligned to at most one target token, and — AQU-1408 —
 * **each target token is claimed by at most one source token**. Only links
 * above `opts.threshold` are returned (default 0.1).
 *
 * The algorithm:
 * 1. Score the candidates:
 *    - Warm: `alignWords` on the trained two-directional model. Its score is
 *      the geometric mean of the two posteriors, and the diagonal prior is
 *      already inside it (AQU-1696).
 *    - Cold: Dice(srcToken, tgtToken) from co-occurrence counts, times
 *      diagonalPrior(srcPos, srcLen, tgtPos, tgtLen).
 * 2. On the warm path, fold in anything the reader has decided about the pair
 *    (`applyDecision`), including a seeded pair the aligner did not propose.
 * 3. Competitive linking: consider every candidate above the threshold in
 *    descending score order and keep it only when neither endpoint is spoken
 *    for. The best claimant of a target word keeps it; a source word that
 *    loses falls through to its next-best free target, or to no link at all.
 *
 * Step 3 used to be a per-source-token argmax, which decided each source token
 * independently and so let several of them land on the same target word — the
 * panel then showed "father" three times over for one "father" in the verse
 * (AQU-1408, Biblica ETT). A one-to-one matching is also what the target-side
 * reading is: a target word means one thing here, not three.
 *
 * Ties are broken by source position, then target position, so the result is
 * deterministic for a given model and cell.
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

  // Score every (source, target) candidate once, keeping only those that clear
  // the display threshold. Scoring is separated from choosing so the choice can
  // be made globally rather than one source token at a time.
  const candidates: { srcIndex: number; tgtIndex: number; confidence: number }[] = []
  const keep = (srcIndex: number, tgtIndex: number, confidence: number) => {
    const clamped = Math.min(1, Math.max(0, confidence))
    if (clamped > 0 && clamped >= threshold) candidates.push({ srcIndex, tgtIndex, confidence: clamped })
  }

  if (model.wordAlign) {
    // The warm aligner proposes its own links; a reader's decision can then
    // raise or lower one, and can introduce a pair the aligner never proposed
    // (a confirmed alignment has to survive the next rebuild — that is what
    // `alignmentSeeds` are for).
    const weightOf = (si: number, ti: number) =>
      model.decisions.get(srcTokens[si])?.get(tgtTokens[ti]) ?? 0
    const proposed = new Set<number>()
    for (const link of alignWords(model.wordAlign, srcTokens, tgtTokens, 0)) {
      proposed.add(link.src * tgtTokens.length + link.tgt)
      keep(link.src, link.tgt, applyDecision(link.conf, weightOf(link.src, link.tgt)))
    }
    // A pair the aligner did not propose at all, but the reader has confirmed
    // or seeded, is still a candidate: a confirmed alignment has to survive the
    // next rebuild.
    if (model.decisions.size > 0) {
      for (let si = 0; si < srcTokens.length; si++) {
        if (!model.decisions.has(srcTokens[si])) continue
        for (let ti = 0; ti < tgtTokens.length; ti++) {
          if (proposed.has(si * tgtTokens.length + ti)) continue
          const weight = weightOf(si, ti)
          if (weight <= 0) continue
          keep(si, ti, applyDecision(0, weight))
        }
      }
    }
  } else {
    for (let si = 0; si < srcTokens.length; si++) {
      const s = srcTokens[si]
      for (let ti = 0; ti < tgtTokens.length; ti++) {
        const rawScore = dice(s, tgtTokens[ti], model.countTable, model.srcCounts, model.tgtCounts)
        if (rawScore === 0) continue
        keep(si, ti, rawScore * diagonalPrior(si, srcTokens.length, ti, tgtTokens.length))
      }
    }
  }

  // Competitive linking: strongest candidate first, and a token on either side
  // can only be spent once. Position tie-breaks keep the walk deterministic.
  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence || a.srcIndex - b.srcIndex || a.tgtIndex - b.tgtIndex,
  )

  const takenSrc = new Set<number>()
  const takenTgt = new Set<number>()
  const links: AlignmentLink[] = []

  for (const { srcIndex, tgtIndex, confidence } of candidates) {
    if (takenSrc.has(srcIndex) || takenTgt.has(tgtIndex)) continue
    takenSrc.add(srcIndex)
    takenTgt.add(tgtIndex)
    links.push({
      srcIndex,
      srcToken: srcTokens[srcIndex],
      tgtIndex,
      tgtToken: tgtTokens[tgtIndex],
      confidence,
    })
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
 * handled by AQU-207. This function only updates the in-memory model.
 *
 * NOTE: on a warm model the decision rides the adjustment layer rather than
 * retraining IBM Model 1, so repeated confirmations saturate instead of moving
 * the trained tables. A full rebuild should still be triggered (debounced)
 * every ~10 confirmations or 60 s of inactivity.
 */
export function confirmAlignment(
  srcToken: string,
  tgtToken: string,
  model: AlignmentModel,
): void {
  const s = srcToken.toLowerCase()
  const t = tgtToken.toLowerCase()
  addCount(model.countTable, s, t, CONFIRM_WEIGHT)
  addDecision(model.decisions, s, t, 1)
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
 * seeds) is handled by AQU-207.
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
  addDecision(model.decisions, s, t, -1)
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
