/**
 * bia-engine.ts — Bidirectional Inverse Attention (BIA) forecasting and the
 * project thesaurus, as one engine.
 *
 * Faithful TypeScript port of Codex Editor's `servers/utils/bia.py`
 * (`predict`, `predict_from`, `combine_counts`, `get_possible_next`,
 * `synonimize`, `combine_votes`) and the two-word extension in
 * `servers/servable_forecasting.py` (codex-editor 2aa88367).
 *
 * ## The algorithm
 *
 * To fill a blank at position t of a token sequence:
 *   1. Anchors: the `topN` (15) rarest words of the sequence, on either side
 *      of the blank, by IDF.
 *   2. For an anchor at distance d = pos − t, read every cell containing it
 *      and take the word at (anchor's position in that cell) − d. Anchors on
 *      the right have d > 0, so they count backwards.
 *   3. Each anchor gives every distinct word it lands on ONE vote (the Python
 *      `combine_counts` counts presence, not occurrences). Here the vote is
 *      the weight of the best cell it landed through: 1 for a validated cell,
 *      FALLBACK_WEIGHT for an unvalidated one.
 *   4. Next-word: the top `limit × 4` candidates are filtered by the forward
 *      Markov chain on the previous word (`can_be_next`), then cut to `limit`.
 *   5. Multi-word: each of the top 4 is extended by re-running next-word on
 *      `context + word` and appending its first result.
 *
 * The thesaurus (`wordsThatFit`) is the same engine with the word blanked out
 * of every cell that contains it (evenly subsampled to `samples`), 7 anchors
 * each, restricted to the span of cells between the word's first and last
 * occurrence; every candidate a sample produces scores IDF² (`combine_votes`).
 *
 * ## Deviations from the Python (intentional)
 *   - Cells are the sentences; Unicode tokenizer instead of `str.split()` /
 *     sklearn's ≥2-char token pattern, so one-character words (CJK) count.
 *   - Search is a posting-list lookup. The Python's `search()` also applied
 *     `start < i < end` with `end = len(relevant) − 1` when no bound was
 *     given, which silently dropped the first sentence and every sentence
 *     whose index exceeded the hit count; that bug is not reproduced. With a
 *     bound, the span is inclusive (the Python excluded both ends).
 *   - A repeated anchor is used once, at its occurrence nearest the blank
 *     (the Python used `list.index`, i.e. the first occurrence, and voted
 *     twice). Equal-IDF anchors are ranked nearest-first.
 *   - Ties in votes break by corpus frequency (the Python's order depended on
 *     thread completion order).
 *   - Prefix completion: when the caret sits inside a word, the partial word
 *     is the blank and candidates must extend it. The Python treated the
 *     partial word as a complete previous word.
 *   - Fallback: when BIA has no candidate that survives the filters, the
 *     Markov followers of the previous word are offered, then (with a prefix)
 *     the most frequent words. The Python returned nothing.
 *   - The Python always included anchors with `abs(distance) < 1` — only the
 *     blank itself, which matched nothing. Read as "the adjacent words", the
 *     neighbours at distance ±1 are always anchors here (`neighbors`).
 *   - Daniel's notes allow the Markov chain to "filter or weight"; the editor
 *     ships "weight" plus 1/|d| vote decay (FAITHFUL_OPTIONS keeps the
 *     Python behaviour for comparison; see the eval results).
 *   - Infill may optionally apply the Markov chain on both sides
 *     (`can_be_next` on the left and the unused `can_preclude` on the right).
 */

import { tokenize } from "@/lib/completion/tokenize"
import { BiaIndex } from "./bia-index"

export type MarkovMode = "filter" | "weight" | "off"

export interface Suggestion {
  /** The full suggested word (first word of a multi-word suggestion). */
  word: string
  /** Text to insert at the caret: the rest of `word` plus any extension. */
  insert: string
  score: number
  source: "bia" | "markov" | "frequency"
}

export interface PredictOptions {
  /** Number of rare-word anchors (Python `top_n`). */
  topN?: number
  /** Inclusive cell-order span (Python `bound`). */
  bound?: readonly [number, number]
  /** Cell to ignore (e.g. the stale committed copy of the cell being edited). */
  excludeCellId?: string
  /** Always anchor on the words right next to the blank (default true). */
  neighbors?: boolean
  /** Vote weight × |distance|^-decay (default 0: one vote per anchor). */
  decay?: number
}

export interface SuggestOptions extends Pick<PredictOptions, "neighbors" | "decay"> {
  limit?: number
  markov?: MarkovMode
  excludeCellId?: string
  /** Extend each suggestion by one word (default true). */
  extend?: boolean
  /** Offer Markov/frequency fallbacks when BIA has nothing (default true). */
  fallback?: boolean
  /**
   * The verse's SOURCE text (or tokens). When given, target words the
   * project's lexicon aligns to it are mixed into the BIA scores.
   */
  source?: string | readonly string[]
  /** Mixing weight alpha of the source score against BIA (0 = source off). */
  sourceWeight?: number
  /** Relative-position falloff lambda for source alignment. */
  sourceLambda?: number
  /**
   * "add": bia + alpha*src (source can introduce new words at full weight);
   * "boost": bia * (1 + alpha*src) + BOOST_FLOOR*alpha*src (source re-ranks
   * BIA's candidates and only weakly introduces its own).
   */
  sourceMix?: SourceMix
  /** Exponent on Dice (sharper = trusts only strong pairs). */
  sourcePower?: number
  /**
   * Exponent on the TARGET word's IDF applied to its source score: > 0 lets
   * the source speak mostly for content words and leaves function words to
   * the left context, where BIA + Markov already predict them well.
   */
  sourceTargetIdf?: number
}

export type SourceMix = "add" | "boost"

/**
 * The Python's behaviour, for evals and comparisons: hard Markov filter, one
 * vote per anchor, no forced neighbours, no fallback.
 */
export const FAITHFUL_OPTIONS: SuggestOptions = { markov: "filter", neighbors: false, decay: 0, fallback: false }

/**
 * Suggestion defaults differ from FAITHFUL_OPTIONS on the evidence of
 * docs/forecast/bia-eval-results.md: votes decay with anchor distance
 * (1/|d|), the Markov chain weights (× 1 + ln(1 + bigram count)) instead of
 * filtering, the blank's immediate neighbours are always anchors, and a
 * fallback keeps coverage at 100%.
 */
export const SHIPPED_DECAY = 1

/**
 * Source mixing, tuned on a dev split carved from the TRAINING verses (never
 * the held-out test verses) by scripts/bia-source-tune.ts:
 *   score(t) = bia(t)/max(bia) + alpha * src(t)/max(src), then the Markov weight.
 */
export const SOURCE_WEIGHT = 2
export const SOURCE_LAMBDA = 8
export const SOURCE_MIX: SourceMix = "add"
export const SOURCE_POWER = 2
export const SOURCE_TARGET_IDF = 3
/** In "boost" mixing, how much a source-only word scores relative to α·src. */
export const BOOST_FLOOR = 0.25

export const DEFAULT_ANCHORS = 15
export const THESAURUS_ANCHORS = 7
export const THESAURUS_SAMPLES = 100
const THESAURUS_PER_SAMPLE = 20
const MULTI_WORD_TOP = 4

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

/** True when `left` ends inside a word (the caret follows a word character). */
export function endsInsideWord(left: string): boolean {
  return left.length > 0 && WORD_CHAR.test(left[left.length - 1])
}

/** True when `right` starts inside a word. */
export function startsInsideWord(right: string): boolean {
  return right.length > 0 && WORD_CHAR.test(right[0])
}

export type Ranked = Array<[string, number]>

export class BiaEngine {
  readonly index: BiaIndex

  constructor(index: BiaIndex = new BiaIndex()) {
    this.index = index
  }

  /**
   * Core BIA vote for the blank at `target` (Python `predict` +
   * `predict_from` + `combine_counts`). `tokens[target]` is ignored.
   */
  predictAt(tokens: readonly string[], target: number, opts: PredictOptions = {}): Ranked {
    const { index } = this
    const topN = opts.topN ?? DEFAULT_ANCHORS
    const nearest = new Map<string, number>()
    tokens.forEach((word, pos) => {
      if (pos === target || !index.has(word)) return
      const prior = nearest.get(word)
      if (prior === undefined || Math.abs(pos - target) < Math.abs(prior - target)) {
        nearest.set(word, pos)
      }
    })
    const ranked = Array.from(nearest.entries())
      .map(([word, pos]) => ({ word, distance: pos - target, idf: index.idf(word) }))
      .sort((a, b) => b.idf - a.idf || Math.abs(a.distance) - Math.abs(b.distance))
    const anchors = ranked.slice(0, topN)
    if (opts.neighbors ?? true) {
      for (const a of ranked.slice(topN)) if (Math.abs(a.distance) === 1) anchors.push(a)
    }
    const decay = opts.decay ?? 0

    const votes = new Map<string, number>()
    for (const { word, distance } of anchors) {
      const landed = new Map<string, number>()
      for (const [cellId, first] of index.postingsOf(word) ?? []) {
        if (cellId === opts.excludeCellId) continue
        const cell = index.cell(cellId)
        if (!cell) continue
        if (opts.bound && (cell.order < opts.bound[0] || cell.order > opts.bound[1])) continue
        // The anchor's FIRST position in the cell, as the Python's
        // `list.index`. (Casting from every occurrence was measured and
        // changed accuracy by < 1 point either way, so the faithful form stays.)
        const cast = first - distance
        if (cast < 0 || cast >= cell.tokens.length) continue
        const hit = cell.tokens[cast]
        if ((landed.get(hit) ?? 0) < cell.weight) landed.set(hit, cell.weight)
      }
      const scale = decay > 0 ? Math.abs(distance) ** -decay : 1
      for (const [hit, weight] of landed) votes.set(hit, (votes.get(hit) ?? 0) + weight * scale)
    }
    return this.rank(votes)
  }

  private rank(scores: Map<string, number>): Ranked {
    const { index } = this
    return Array.from(scores.entries()).sort(
      (a, b) => b[1] - a[1] || index.frequency(b[0]) - index.frequency(a[0]) || (a[0] < b[0] ? -1 : 1),
    )
  }

  /** Apply the Markov chain to a ranked list (Python `get_possible_next`). */
  private markov(ranked: Ranked, prev: string | undefined, next: string | undefined, mode: MarkovMode, limit: number): Ranked {
    if (mode === "off" || (prev === undefined && next === undefined)) return ranked
    const { index } = this
    if (mode === "filter") {
      return ranked
        .slice(0, limit * 4)
        .filter(([w]) => (prev === undefined || index.canBeNext(prev, w)) && (next === undefined || index.canPrecede(w, next)))
    }
    const weighted = ranked.map(([w, s]): [string, number] => {
      let factor = 1
      if (prev !== undefined) factor *= 1 + Math.log1p(index.bigram(prev, w))
      if (next !== undefined) factor *= 1 + Math.log1p(index.bigram(w, next))
      return [w, s * factor]
    })
    return weighted.sort((a, b) => b[1] - a[1] || index.frequency(b[0]) - index.frequency(a[0]))
  }

  /**
   * Ranked single words for the blank between `leftTokens` and `rightTokens`.
   * `prefix` (possibly "") constrains candidates to extend a partial word.
   */
  private fill(
    leftTokens: readonly string[],
    rightTokens: readonly string[],
    prefix: string,
    opts: SuggestOptions,
  ): Array<{ word: string; score: number; source: Suggestion["source"] }> {
    const limit = opts.limit ?? 4
    const mode = opts.markov ?? "weight"
    const tokens = [...leftTokens, "", ...rightTokens]
    const target = leftTokens.length
    const prev = leftTokens.at(-1)
    const next = rightTokens[0]
    const fits = (w: string) => w.startsWith(prefix) && w !== prefix
    let ranked = this.predictAt(tokens, target, {
      excludeCellId: opts.excludeCellId,
      neighbors: opts.neighbors,
      decay: opts.decay ?? SHIPPED_DECAY,
    })
    const source = this.sourceTokens(opts.source)
    const alpha = opts.sourceWeight ?? SOURCE_WEIGHT
    if (source.length > 0 && alpha > 0) {
      const aligned = this.index.lexicon.scoreTargets(source, {
        left: leftTokens,
        right: rightTokens,
        excludeCellId: opts.excludeCellId,
        lambda: opts.sourceLambda ?? SOURCE_LAMBDA,
        power: opts.sourcePower ?? SOURCE_POWER,
      })
      const q = opts.sourceTargetIdf ?? SOURCE_TARGET_IDF
      if (q !== 0) for (const [t, v] of aligned) aligned.set(t, v * this.index.idf(t) ** q)
      ranked = this.rank(mixScores(ranked, aligned, alpha, opts.sourceMix ?? SOURCE_MIX))
    }
    if (prefix) ranked = ranked.filter(([w]) => fits(w))
    ranked = this.markov(ranked, prev, next, mode, limit)
    const out = ranked.slice(0, limit).map(([word, score]) => ({ word, score, source: "bia" as const }))
    if (out.length > 0 || opts.fallback === false) return out

    if (prev !== undefined) {
      const followers = this.index.followers(prev).filter(([w]) => fits(w))
      if (followers.length > 0) {
        return followers.slice(0, limit).map(([word, score]) => ({ word, score, source: "markov" as const }))
      }
    }
    if (!prefix) return []
    return this.index
      .vocabularyByFrequency()
      .filter(([w]) => fits(w))
      .slice(0, limit)
      .map(([word, score]) => ({ word, score, source: "frequency" as const }))
  }

  private sourceTokens(source: SuggestOptions["source"]): readonly string[] {
    if (source === undefined) return []
    return typeof source === "string" ? tokenize(source) : source
  }

  /** Next word(s) after `left` (Python `get_possible_next` + 2-word extension). */
  suggestNext(left: string, opts: SuggestOptions = {}): Suggestion[] {
    const inside = endsInsideWord(left)
    const tokens = tokenize(left)
    const prefix = inside ? (tokens.pop() ?? "") : ""
    const words = this.fill(tokens, [], prefix, opts)
    const extend = opts.extend ?? true
    const { index } = this
    return words.map(({ word, score, source }, rank) => {
      const shown = index.display(word)
      let insert = shown.slice(prefix.length)
      if (extend && rank < MULTI_WORD_TOP) {
        const [follow] = this.fill([...tokens, word], [], "", { ...opts, limit: 1 })
        if (follow) insert += ` ${index.display(follow.word)}`
      }
      return { word: shown, insert, score, source }
    })
  }

  /** The word for a blank between `left` and `right` (Python `predict`). */
  suggestInfill(left: string, right: string, opts: SuggestOptions = {}): Suggestion[] {
    const inside = endsInsideWord(left)
    const leftTokens = tokenize(left)
    const prefix = inside ? (leftTokens.pop() ?? "") : ""
    const rightTokens = tokenize(right)
    return this.fill(leftTokens, rightTokens, prefix, opts).map(({ word, score, source }) => {
      const shown = this.index.display(word)
      return { word: shown, insert: shown.slice(prefix.length), score, source }
    })
  }

  /**
   * Thesaurus: words that fit where `word` fits (Python `synonimize` +
   * `combine_votes`). With `context`, the sentence being edited is one more
   * sample, so the list also reflects "here".
   */
  wordsThatFit(
    word: string,
    opts: {
      context?: { left: string; right: string }
      limit?: number
      samples?: number
      excludeCellId?: string
      /** "idf2" = the Python `combine_votes`; "votes" (default) = vote share. */
      weighting?: "idf2" | "votes"
      /** The verse's source: words translating the same source word rank up. */
      source?: string | readonly string[]
      sourceWeight?: number
    } = {},
  ): Array<{ word: string; score: number }> {
    const target = tokenize(word)[0]
    if (!target) return []
    const { index } = this
    const posting = index.postingsOf(target)
    const sampleIds = posting ? Array.from(posting.keys()) : []
    const orders = sampleIds.map((id) => index.cell(id)?.order ?? 0)
    const bound: readonly [number, number] | undefined =
      orders.length > 0 ? [Math.min(...orders), Math.max(...orders)] : undefined
    sampleIds.sort((a, b) => (index.cell(a)?.order ?? 0) - (index.cell(b)?.order ?? 0))
    const cap = opts.samples ?? THESAURUS_SAMPLES
    const step = Math.max(1, Math.floor(sampleIds.length / cap))
    const samples: Array<{ tokens: readonly string[]; at: number }> = []
    for (let i = 0; i < sampleIds.length; i += step) {
      const id = sampleIds[i]
      if (id === opts.excludeCellId) continue
      const cell = index.cell(id)
      const at = posting?.get(id)
      if (cell && at !== undefined) samples.push({ tokens: cell.tokens, at })
    }
    if (opts.context) {
      const left = tokenize(opts.context.left)
      samples.push({ tokens: [...left, target, ...tokenize(opts.context.right)], at: left.length })
    }

    const faithful = opts.weighting === "idf2"
    const combined = new Map<string, number>()
    for (const sample of samples) {
      const ranked = this.predictAt(sample.tokens, sample.at, {
        topN: THESAURUS_ANCHORS,
        bound,
        excludeCellId: opts.excludeCellId,
        decay: faithful ? 0 : SHIPPED_DECAY,
      }).filter(([candidate]) => candidate !== target)
      if (faithful) {
        for (const [candidate] of ranked) {
          const idf = index.idf(candidate)
          combined.set(candidate, (combined.get(candidate) ?? 0) + idf * idf)
        }
        continue
      }
      // Default weighting keeps the Python's IDF² but scales it by the
      // candidate's vote share in the sample (a stray single-anchor landing
      // scores little) over the top THESAURUS_PER_SAMPLE candidates that the
      // Markov chain allows between the blank's neighbours. The faithful
      // IDF²-for-every-candidate ranks hapaxes first (pace, processions,
      // bereaving for "king"); this gives men, people, house, father.
      const prev = sample.tokens[sample.at - 1]
      const next = sample.tokens[sample.at + 1]
      const fitsLeft = (c: string) => prev === undefined || index.canBeNext(prev, c)
      const fitsRight = (c: string) => next === undefined || index.canPrecede(c, next)
      // Both neighbours when possible; one side when a rare neighbour (only
      // ever seen beside the word itself) would otherwise rule out everything.
      let fitting = ranked.filter(([c]) => fitsLeft(c) && fitsRight(c))
      if (fitting.length === 0) fitting = ranked.filter(([c]) => fitsLeft(c) || fitsRight(c))
      const top = fitting[0]?.[1] ?? 0
      for (const [candidate, votes] of fitting.slice(0, THESAURUS_PER_SAMPLE)) {
        const idf = index.idf(candidate)
        combined.set(candidate, (combined.get(candidate) ?? 0) + (votes / top) * idf * idf)
      }
    }
    combined.delete(target)
    const source = this.sourceTokens(opts.source)
    const alpha = opts.sourceWeight ?? SOURCE_WEIGHT
    const scored = source.length > 0 && alpha > 0
      ? mixScores(this.rank(combined), this.sourceAlternatives(target, source, opts.excludeCellId), alpha)
      : combined
    scored.delete(target)
    const total = Array.from(scored.values()).reduce((a, b) => a + b, 0)
    return this.rank(scored)
      .slice(0, opts.limit ?? 10)
      .map(([w, s]) => ({ word: index.display(w), score: total > 0 ? s / total : 0 }))
  }

  /**
   * Other target words for the source word(s) `target` translates here:
   * sum over the verse's source words s of idf(s) * dice(s, target) * dice(s, t).
   */
  private sourceAlternatives(target: string, source: readonly string[], excludeCellId?: string): Map<string, number> {
    const { lexicon } = this.index
    const pairs = lexicon.pairCount
    const out = new Map<string, number>()
    for (const s of new Set(source)) {
      const assoc = lexicon.associations(s, excludeCellId)
      const anchor = assoc.find(([t]) => t === target)?.[1] ?? 0
      if (anchor === 0) continue
      const weight = lexicon.idf(s, pairs) * anchor
      for (const [t, d] of assoc) out.set(t, (out.get(t) ?? 0) + weight * d)
    }
    return out
  }
}

/** Max-normalise both score sets and add alpha x the second to the first. */
export function mixScores(
  primary: Ranked,
  secondary: ReadonlyMap<string, number>,
  alpha: number,
  mode: SourceMix = "add",
): Map<string, number> {
  const topPrimary = primary[0]?.[1] ?? 0
  let topSecondary = 0
  for (const v of secondary.values()) if (v > topSecondary) topSecondary = v
  const out = new Map<string, number>()
  for (const [w, v] of primary) out.set(w, topPrimary > 0 ? v / topPrimary : 0)
  if (topSecondary === 0) return out
  for (const [w, v] of secondary) {
    const s = (alpha * v) / topSecondary
    const b = out.get(w) ?? 0
    out.set(w, mode === "boost" ? b * (1 + s) + BOOST_FLOOR * s : b + s)
  }
  return out
}
