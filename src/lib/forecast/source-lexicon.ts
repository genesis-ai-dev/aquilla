/**
 * source-lexicon.ts — a project-learned translation lexicon for BIA.
 *
 * Model-free and incremental: the only stored state is each cell's source
 * tokens and a source-word posting list over the cells that also have target
 * text. Associations are computed on demand, per source word, as the Dice
 * coefficient of "s in the source" and "t in the target" across those cell
 * pairs (weighted by the cell's validation weight), and cached until the
 * corpus changes. A query only ever touches the rare source words of ONE
 * verse, so the cost is a few small posting lists, not a vocabulary² table.
 *
 * Scoring the target words for a cursor position:
 *
 *   score(t) = Σ over source tokens s_i of
 *                idf(s) · dice(s, t) · exp(−λ · |r(s_i) − r_cursor|)
 *
 * where r(s_i) is the token's relative position in the source and r_cursor
 * the cursor's relative position in the (expected-length) target, and a word
 * the translator already typed counts COVERED_PENALTY as much — its source
 * word is probably translated already.
 */

import { wordKeys } from "./forecast-tokenize"

/** Source words in more cells than this carry no alignment signal worth the scan. */
const MAX_SOURCE_DF = 4000
/** Target words kept per source word after ranking by Dice. */
const TOP_TARGETS = 40
/** Weight of a target word the translator has already used in this verse. */
export const COVERED_PENALTY = 0.25

export interface PairCells {
  /** Target tokens and weight of an indexed cell, if it has target text. */
  target(id: string): { tokens: readonly string[]; weight: number } | undefined
  /** Number of target cells containing `word`. */
  targetDf(word: string): number
}

export interface SourceScoreOptions {
  /** Target words before the blank (the cursor is after the last one). */
  left: readonly string[]
  /** Target words after the blank (infill), if any. */
  right?: readonly string[]
  excludeCellId?: string
  /** Position falloff λ (0 = position-blind). */
  lambda: number
  /** Exponent on Dice (default 1). */
  power?: number
}

export class SourceLexicon {
  private readonly sources = new Map<string, string[]>()
  /** source word → cells that have both this word in the source AND target text. */
  private readonly postings = new Map<string, Set<string>>()
  private readonly cache = new Map<string, Array<[string, number]>>()
  /** Paired cells → [source tokens, target tokens] counted into the ratio. */
  private readonly paired = new Map<string, [number, number]>()
  private pairSourceTokens = 0
  private pairTargetTokens = 0
  private readonly pairs: PairCells

  constructor(pairs: PairCells) {
    this.pairs = pairs
  }

  /** Record a cell's source text (call after its target is indexed or removed). */
  set(id: string, source: string | undefined): void {
    this.remove(id)
    const tokens = source ? wordKeys(source) : []
    if (tokens.length === 0) return
    this.sources.set(id, tokens)
    const target = this.pairs.target(id)
    if (!target) return
    for (const word of new Set(tokens)) {
      let posting = this.postings.get(word)
      if (!posting) {
        posting = new Set()
        this.postings.set(word, posting)
      }
      posting.add(id)
    }
    this.paired.set(id, [tokens.length, target.tokens.length])
    this.pairSourceTokens += tokens.length
    this.pairTargetTokens += target.tokens.length
    this.cache.clear()
  }

  remove(id: string): void {
    const tokens = this.sources.get(id)
    if (!tokens) return
    this.sources.delete(id)
    const lengths = this.paired.get(id)
    if (!lengths) return
    this.paired.delete(id)
    for (const word of new Set(tokens)) {
      const posting = this.postings.get(word)
      posting?.delete(id)
      if (posting?.size === 0) this.postings.delete(word)
    }
    this.pairSourceTokens -= lengths[0]
    this.pairTargetTokens -= lengths[1]
    this.cache.clear()
  }

  clear(): void {
    this.sources.clear()
    this.postings.clear()
    this.cache.clear()
    this.paired.clear()
    this.pairSourceTokens = 0
    this.pairTargetTokens = 0
  }

  /** The stored source tokens of a cell (any cell, translated or not). */
  sourceOf(id: string): readonly string[] | undefined {
    return this.sources.get(id)
  }

  /** Cells with both source and target text. */
  get pairCount(): number {
    return this.paired.size
  }

  /** Average target tokens per source token over the paired cells. */
  get lengthRatio(): number {
    return this.pairSourceTokens > 0 ? this.pairTargetTokens / this.pairSourceTokens : 1
  }

  /** Smoothed IDF of a source word over paired cells. */
  idf(word: string, pairs: number): number {
    const df = this.postings.get(word)?.size ?? 0
    return Math.log((1 + pairs) / (1 + df)) + 1
  }

  /** Target words most associated with source word `s`, by Dice, best first. */
  associations(s: string, excludeCellId?: string): ReadonlyArray<[string, number]> {
    const posting = this.postings.get(s)
    if (!posting || posting.size > MAX_SOURCE_DF) return []
    const useCache = excludeCellId === undefined || !posting.has(excludeCellId)
    const cached = useCache ? this.cache.get(s) : undefined
    if (cached) return cached
    const co = new Map<string, number>()
    let dfS = 0
    for (const id of posting) {
      if (id === excludeCellId) continue
      const target = this.pairs.target(id)
      if (!target) continue
      dfS += target.weight
      for (const t of new Set(target.tokens)) co.set(t, (co.get(t) ?? 0) + target.weight)
    }
    const ranked: Array<[string, number]> = []
    for (const [t, c] of co) ranked.push([t, (2 * c) / (dfS + this.pairs.targetDf(t))])
    ranked.sort((a, b) => b[1] - a[1])
    const top = ranked.slice(0, TOP_TARGETS)
    if (useCache) this.cache.set(s, top)
    return top
  }

  /** Dice of one source/target word pair (0 when unseen or too common). */
  dice(s: string, t: string, excludeCellId?: string): number {
    return this.associations(s, excludeCellId).find(([w]) => w === t)?.[1] ?? 0
  }

  /** Target-word scores for a blank, from the verse's source tokens. */
  scoreTargets(source: readonly string[], opts: SourceScoreOptions): Map<string, number> {
    const scores = new Map<string, number>()
    if (source.length === 0) return scores
    const pairs = this.pairCount
    const right = opts.right ?? []
    // Where the cursor sits in the target: exact for infill, against the
    // source length × the corpus length ratio for next-word.
    const expected = right.length > 0
      ? opts.left.length + 1 + right.length
      : Math.max(opts.left.length + 1, source.length * this.lengthRatio)
    const cursor = (opts.left.length + 0.5) / expected
    const used = new Set([...opts.left, ...right])
    const power = opts.power ?? 1
    source.forEach((s, i) => {
      const assoc = this.associations(s, opts.excludeCellId)
      if (assoc.length === 0) return
      const weight = this.idf(s, pairs) * Math.exp(-opts.lambda * Math.abs((i + 0.5) / source.length - cursor))
      for (const [t, d] of assoc) {
        const covered = used.has(t) ? COVERED_PENALTY : 1
        scores.set(t, (scores.get(t) ?? 0) + weight * d ** power * covered)
      }
    })
    return scores
  }
}
