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
 *   - Cells are the sentences; a language-agnostic word segmenter
 *     (forecast-tokenize.ts: NFC, Intl.Segmenter, locale-independent case
 *     folding) instead of `str.split()` / sklearn's ≥2-char token pattern, so
 *     one-character words (CJK) count and spaceless scripts split into words.
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
 *   - Next-word without a source signal restores the per-distance chains of
 *     Daniel's 2024 forecaster (full counts of the word 1, 2, 3 places after
 *     each word, product of experts) — see `chains`. With a source verse the
 *     bigram factor + source lexicon measured better, so it stays.
 *   - Infill may optionally apply the Markov chain on both sides
 *     (`can_be_next` on the left and the unused `can_preclude` on the right).
 */

import { isSpaceless, isWordChar, joiner, segmentWords, wordKeys } from "./forecast-tokenize"
import { mixScores, type SourceMix } from "./mix"
import { wordsThatFit as thesaurus, type ThesaurusOptions } from "./thesaurus"

export { mixScores, type SourceMix } from "./mix"
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
  /** Weight β of the grapheme-stem back-off in the source lexicon (0 = off). */
  sourceStemWeight?: number
  /**
   * Next-word mode only: weight candidates by the per-distance chains of
   * Daniel's 2024 forecaster, Π_k (P_k(w | word k back) + ε·P(w))^(1/k) for
   * k = 1..3, instead of the bigram factor 1 + ln(1 + count(prev→w)).
   * Default: on exactly when there is no source signal for the cell (see
   * `fill`); with a source verse the bigram factor measured better.
   */
  chains?: boolean
  /**
   * With chains: skip the BIA vote and rank only the chains' own candidates.
   * Default: on whenever chains are on by default (same accuracy on dev,
   * 5–20× faster).
   */
  chainsOnly?: boolean
}

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
export const SOURCE_STEM_WEIGHT = 0
/** Unigram smoothing ε in the per-distance chain factor. */
const CHAIN_EPSILON = 0.001


export const DEFAULT_ANCHORS = 15
const MULTI_WORD_TOP = 4

/** True when `left` ends inside a word (the caret follows a word character). */
export function endsInsideWord(left: string): boolean {
  return isWordChar(left.at(-1)) || left.endsWith("'")
}

/** True when `right` starts inside a word. */
export function startsInsideWord(right: string): boolean {
  return isWordChar(right[0])
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

  /** Scores, best first; ties by corpus frequency, then alphabetically. */
  rank(scores: Map<string, number>): Ranked {
    const { index } = this
    return Array.from(scores.entries()).sort(
      (a, b) => b[1] - a[1] || index.frequency(b[0]) - index.frequency(a[0]) || (a[0] < b[0] ? -1 : 1),
    )
  }

  /** Apply the Markov chain to a ranked list (Python `get_possible_next`). */
  private markov(
    ranked: Ranked,
    prev: string | undefined,
    next: string | undefined,
    mode: MarkovMode,
    limit: number,
    chainContext?: readonly string[],
  ): Ranked {
    if (mode === "off" || (prev === undefined && next === undefined)) return ranked
    const { index } = this
    if (mode === "weight" && chainContext && next === undefined) {
      const depth = Math.min(index.chainDepth, chainContext.length)
      const chained = ranked.map(([w, s]): [string, number] => {
        let log = 0
        const floor = CHAIN_EPSILON * index.probability(w)
        for (let k = 1; k <= depth; k++) {
          log += Math.log(index.chainProbability(k, chainContext[chainContext.length - k], w) + floor) / k
        }
        return [w, s * Math.exp(log)]
      })
      return chained.sort((a, b) => b[1] - a[1] || index.frequency(b[0]) - index.frequency(a[0]))
    }
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
    const source = this.sourceTokens(opts.source)
    const alpha = opts.sourceWeight ?? SOURCE_WEIGHT
    // Is there anything for the source term to say? (A verse, a weight, and
    // translated pairs to have learned a lexicon from.)
    const sourceSignal = source.length > 0 && alpha > 0 && this.index.lexicon.pairCount > 0
    const nextWord = rightTokens.length === 0
    const chains = nextWord && (opts.chains ?? !sourceSignal)
    const chainsOnly = chains && (opts.chainsOnly ?? opts.chains === undefined)
    let ranked = chainsOnly ? this.chainCandidates(leftTokens) : this.predictAt(tokens, target, {
      excludeCellId: opts.excludeCellId,
      neighbors: opts.neighbors,
      decay: opts.decay ?? SHIPPED_DECAY,
    })
    if (sourceSignal) {
      const aligned = this.index.lexicon.scoreTargets(source, {
        left: leftTokens,
        right: rightTokens,
        excludeCellId: opts.excludeCellId,
        lambda: opts.sourceLambda ?? SOURCE_LAMBDA,
        power: opts.sourcePower ?? SOURCE_POWER,
        stemWeight: opts.sourceStemWeight ?? SOURCE_STEM_WEIGHT,
      })
      const q = opts.sourceTargetIdf ?? SOURCE_TARGET_IDF
      if (q !== 0) for (const [t, v] of aligned) aligned.set(t, v * this.index.idf(t) ** q)
      ranked = this.rank(mixScores(ranked, aligned, alpha, opts.sourceMix ?? SOURCE_MIX))
    }
    if (prefix) ranked = ranked.filter(([w]) => fits(w))
    ranked = this.markov(ranked, prev, next, mode, limit, chains ? leftTokens : undefined)
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

  /** Every word the per-distance chains have seen after the last 3 words (score 1). */
  private chainCandidates(left: readonly string[]): Ranked {
    const seen = new Set<string>()
    for (let k = 1; k <= Math.min(this.index.chainDepth, left.length); k++) {
      for (const w of this.index.chainFollowers(k, left[left.length - k])) seen.add(w)
    }
    return Array.from(seen, (w): [string, number] => [w, 1])
  }

  private sourceTokens(source: SuggestOptions["source"]): readonly string[] {
    if (source === undefined) return []
    return typeof source === "string" ? wordKeys(source) : source
  }

  /**
   * Split the text before the caret into context keys and the partial word
   * the caret is in (if any). In a script written without spaces, a caret
   * right after a complete, known word is a word boundary, not a prefix.
   */
  private caret(left: string): { tokens: string[]; prefix: string; typed: string } {
    const words = segmentWords(left)
    const last = words.at(-1)
    const tokens = words.map((w) => w.key)
    if (!last || last.end !== left.normalize("NFC").length) return { tokens, prefix: "", typed: "" }
    if (isSpaceless(last.surface.at(-1)) && this.index.has(last.key)) return { tokens, prefix: "", typed: "" }
    tokens.pop()
    return { tokens, prefix: last.key, typed: last.surface }
  }

  /** The part of `shown` still to type after the partial word `typed`. */
  private remainder(shown: string, typed: string): string {
    return typed && shown.length >= typed.length ? shown.slice(typed.length) : shown
  }

  /** Next word(s) after `left` (Python `get_possible_next` + 2-word extension). */
  suggestNext(left: string, opts: SuggestOptions = {}): Suggestion[] {
    const { tokens, prefix, typed } = this.caret(left)
    const words = this.fill(tokens, [], prefix, opts)
    const extend = opts.extend ?? true
    const { index } = this
    return words.map(({ word, score, source }, rank) => {
      const shown = index.display(word)
      let insert = this.remainder(shown, typed)
      if (extend && rank < MULTI_WORD_TOP) {
        const [follow] = this.fill([...tokens, word], [], "", { ...opts, limit: 1 })
        if (follow) {
          const next = index.display(follow.word)
          insert += joiner(shown, next) + next
        }
      }
      return { word: shown, insert, score, source }
    })
  }

  /** The word for a blank between `left` and `right` (Python `predict`). */
  suggestInfill(left: string, right: string, opts: SuggestOptions = {}): Suggestion[] {
    const { tokens, prefix, typed } = this.caret(left)
    const rightTokens = wordKeys(right)
    return this.fill(tokens, rightTokens, prefix, opts).map(({ word, score, source }) => {
      const shown = this.index.display(word)
      return { word: shown, insert: this.remainder(shown, typed), score, source }
    })
  }

  /**
   * Thesaurus: words that fit where `word` fits — see thesaurus.ts.
   */
  wordsThatFit(word: string, opts: ThesaurusOptions = {}): Array<{ word: string; score: number }> {
    return thesaurus(this, word, opts, { decay: SHIPPED_DECAY, sourceWeight: SOURCE_WEIGHT })
  }
}

