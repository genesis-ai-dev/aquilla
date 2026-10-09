/**
 * bia-index.ts — the corpus index behind Bidirectional Inverse Attention.
 *
 * Port of the data half of Codex Editor's `servers/utils/bia.py`
 * (genesis-ai-dev/codex-editor @ 1e47b0a0, the parent of 08e93905):
 *
 *   - `TfidfVectorizer` over sentences  → a posting list per word (which cells
 *     contain it, and where) plus document frequencies for the smoothed IDF
 *     sklearn uses (`ln((1 + n) / (1 + df)) + 1`). The TF half of TF-IDF was
 *     only ever used to answer "which sentences contain this word?", so a
 *     posting list answers it exactly, without the matrix.
 *   - `MarkovChain`                     → forward and reverse bigram tables.
 *
 * Differences from the Python, all deliberate (see docs in bia-engine.ts):
 *   - A "sentence" is an Aquilla cell, not a regex split on `.`/`?` of one big
 *     text file; words come from forecast-tokenize.ts (NFC, Intl.Segmenter
 *     word boundaries, so spaceless scripts and pointed vowels work). Words
 *     are keyed case-folded (as the Python lower-cased the corpus) but the most
 *     common surface spelling is kept for display ("Dios", not "dios").
 *   - Bigrams never cross a cell boundary (the Python chained the whole corpus).
 *   - Every cell carries a weight: validated cells count 1, unvalidated
 *     target cells count FALLBACK_WEIGHT. Counts are weight sums.
 *   - The index is incremental: `upsert` / `remove` adjust every table in
 *     O(tokens in the cell), so an edit never rebuilds the corpus.
 *
 * Pure, synchronous, no DOM — runs in a Web Worker or a test.
 */

import { SourceLexicon } from "./source-lexicon"

import { graphemes, segmentWords } from "./forecast-tokenize"

/** A sentence-initial capital says little about a word's usual spelling. */
const INITIAL_SURFACE_WEIGHT = 0.01

/** Weight of a target cell that is not validated (validated cells weigh 1). */
export const FALLBACK_WEIGHT = 0.5

export interface ForecastCell {
  id: string
  /** Plain target text. */
  text: string
  validated: boolean
  /**
   * Position of the cell in reading order across the corpus. Used for the
   * thesaurus' locality bound (the Python `bound=` argument). Defaults to
   * insertion order.
   */
  order?: number
  /**
   * Plain SOURCE text of the same cell. Feeds the translation lexicon (paired
   * cells) and, for a cell with no target yet, is what a suggestion for that
   * cell aligns against.
   */
  source?: string
}

interface IndexedCell {
  tokens: string[]
  surface: string[]
  weight: number
  order: number
}

type WeightTable = Map<string, Map<string, number>>

const EPSILON = 1e-9

function bump(table: WeightTable, a: string, b: string, by: number): void {
  let row = table.get(a)
  if (!row) {
    if (by <= 0) return
    row = new Map()
    table.set(a, row)
  }
  const next = (row.get(b) ?? 0) + by
  if (next <= EPSILON) {
    row.delete(b)
    if (row.size === 0) table.delete(a)
  } else {
    row.set(b, next)
  }
}

/**
 * Stem length in graphemes for the source lexicon's back-off: a target word's
 * first N user-perceived characters, no per-language rules. Inflected forms
 * of one stem pool their source evidence (see source-lexicon.ts). 0 = off.
 */
export const STEM_GRAPHEMES = 0

export interface BiaIndexOptions {
  stemGraphemes?: number
}

export class BiaIndex {
  private readonly cells = new Map<string, IndexedCell>()
  readonly stemGraphemes: number
  /** stem → number of target cells with a word of that stem (weighted). */
  private readonly stemDfs = new Map<string, number>()
  /** stem → (word → weighted occurrences): the forms a stem expands to. */
  private readonly stemForms: WeightTable = new Map()
  /** word → (cellId → first position of the word in that cell). */
  private readonly postings = new Map<string, Map<string, number>>()
  /** word → weighted occurrence count. */
  private readonly freq = new Map<string, number>()
  /** word → (surface spelling → weight). */
  private readonly surfaces: WeightTable = new Map()
  /** prev → (next → weight): the Python `MarkovChain.mapping`. */
  private readonly forward: WeightTable = new Map()
  /** next → (prev → weight): the Python `MarkovChain.reverse_mapping`. */
  private readonly backward: WeightTable = new Map()
  /**
   * Per-distance chains (Daniel's 2024 Codex Editor forecaster, before BIA):
   * chains[k-1] maps a word to the words found exactly k places after it,
   * with full counts; chainTotals[k-1] the row sums. k = 1 is `forward`.
   */
  private readonly chains: WeightTable[] = [this.forward, new Map(), new Map()]
  private readonly chainTotals: Array<Map<string, number>> = [new Map(), new Map(), new Map()]
  private totalWeight = 0
  private nextOrder = 0
  /** Source-side lexicon over the same cells (see source-lexicon.ts). */
  readonly lexicon: SourceLexicon = new SourceLexicon({
    target: (id) => this.cells.get(id),
    targetDf: (word) => this.postings.get(word)?.size ?? 0,
    stemOf: (word) => this.stemOf(word),
    stemDf: (stem) => this.stemDfs.get(stem) ?? 0,
    formsOf: (stem) => this.stemForms.get(stem),
  })

  constructor(opts: BiaIndexOptions = {}) {
    this.stemGraphemes = opts.stemGraphemes ?? STEM_GRAPHEMES
  }

  /** The word's first `stemGraphemes` graphemes (the word itself if shorter, or "" when off). */
  stemOf(word: string): string {
    if (this.stemGraphemes <= 0) return ""
    const chars = graphemes(word)
    return chars.length > this.stemGraphemes ? chars.slice(0, this.stemGraphemes).join("") : word
  }

  /** Number of indexed cells (the IDF `n`). */
  get size(): number {
    return this.cells.size
  }

  /** Add or replace cells. Empty text removes the cell's target (its source stays). */
  upsert(cells: readonly ForecastCell[]): void {
    for (const cell of cells) {
      this.lexicon.remove(cell.id)
      this.removeOne(cell.id)
      const words = segmentWords(cell.text)
      const surface = words.map((w) => w.surface)
      const tokens = words.map((w) => w.key)
      if (tokens.length > 0) {
        const order = cell.order ?? this.nextOrder
        this.nextOrder = Math.max(this.nextOrder, order + 1)
        const weight = cell.validated ? 1 : FALLBACK_WEIGHT
        this.cells.set(cell.id, { tokens, surface, weight, order })
        this.apply(cell.id, tokens, surface, weight, 1)
      }
      this.lexicon.set(cell.id, cell.source)
    }
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      this.lexicon.remove(id)
      this.removeOne(id)
    }
  }

  clear(): void {
    this.cells.clear()
    this.lexicon.clear()
    this.postings.clear()
    this.freq.clear()
    this.surfaces.clear()
    this.stemDfs.clear()
    this.stemForms.clear()
    this.forward.clear()
    for (const table of this.chains) table.clear()
    for (const totals of this.chainTotals) totals.clear()
    this.totalWeight = 0
    this.backward.clear()
    this.nextOrder = 0
  }

  private removeOne(id: string): void {
    const existing = this.cells.get(id)
    if (!existing) return
    this.cells.delete(id)
    this.apply(id, existing.tokens, existing.surface, existing.weight, -1)
  }

  private apply(id: string, tokens: readonly string[], surface: readonly string[], weight: number, sign: 1 | -1): void {
    const seen = new Set<string>()
    if (this.stemGraphemes > 0) {
      const stems = new Set<string>()
      for (const word of tokens) {
        const stem = this.stemOf(word)
        stems.add(stem)
        bump(this.stemForms, stem, word, sign * weight)
      }
      for (const stem of stems) {
        const df = (this.stemDfs.get(stem) ?? 0) + sign
        if (df <= 0) this.stemDfs.delete(stem)
        else this.stemDfs.set(stem, df)
      }
    }
    tokens.forEach((word, pos) => {
      bump(this.surfaces, word, surface[pos], sign * weight * (pos === 0 ? INITIAL_SURFACE_WEIGHT : 1))
      const f = (this.freq.get(word) ?? 0) + sign * weight
      if (f <= EPSILON) this.freq.delete(word)
      else this.freq.set(word, f)
      if (!seen.has(word)) {
        seen.add(word)
        let posting = this.postings.get(word)
        if (sign > 0) {
          if (!posting) {
            posting = new Map()
            this.postings.set(word, posting)
          }
          posting.set(id, pos)
        } else if (posting) {
          posting.delete(id)
          if (posting.size === 0) this.postings.delete(word)
        }
      }
      this.totalWeight += sign * weight
      if (pos > 0) {
        const prev = tokens[pos - 1]
        bump(this.backward, word, prev, sign * weight)
      }
      for (let k = 1; k <= this.chains.length && pos - k >= 0; k++) {
        const back = tokens[pos - k]
        bump(this.chains[k - 1], back, word, sign * weight)
        const totals = this.chainTotals[k - 1]
        const t = (totals.get(back) ?? 0) + sign * weight
        if (t <= EPSILON) totals.delete(back)
        else totals.set(back, t)
      }
    })
  }

  /** P(word appears k places after `back`), from the per-distance chains. */
  chainProbability(k: number, back: string, word: string): number {
    const total = this.chainTotals[k - 1]?.get(back) ?? 0
    if (total <= 0) return 0
    return (this.chains[k - 1].get(back)?.get(word) ?? 0) / total
  }

  /** Words seen exactly k places after `back`. */
  chainFollowers(k: number, back: string): Iterable<string> {
    return this.chains[k - 1]?.get(back)?.keys() ?? []
  }

  /** Unigram probability of `word`. */
  probability(word: string): number {
    return this.totalWeight > 0 ? (this.freq.get(word) ?? 0) / this.totalWeight : 0
  }

  /** Number of chain distances kept (3). */
  get chainDepth(): number {
    return this.chains.length
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The word's most common spelling in the corpus (the key itself if unseen). */
  display(word: string): string {
    const row = this.surfaces.get(word)
    if (!row) return word
    let best = word
    let bestWeight = -1
    for (const [form, w] of row) {
      if (w > bestWeight) {
        best = form
        bestWeight = w
      }
    }
    return best
  }

  has(word: string): boolean {
    return this.postings.has(word)
  }

  /** sklearn's smoothed IDF; unseen words get the maximum. */
  idf(word: string): number {
    const df = this.postings.get(word)?.size ?? 0
    return Math.log((1 + this.cells.size) / (1 + df)) + 1
  }

  frequency(word: string): number {
    return this.freq.get(word) ?? 0
  }

  /** (cellId → first position) for every cell containing `word`. */
  postingsOf(word: string): ReadonlyMap<string, number> | undefined {
    return this.postings.get(word)
  }

  cell(id: string): Readonly<IndexedCell> | undefined {
    return this.cells.get(id)
  }

  /** Python `MarkovChain.can_be_next`: unknown `last` lets everything through. */
  canBeNext(last: string, next: string): boolean {
    const row = this.forward.get(last)
    return !row || row.has(next)
  }

  /** Python `MarkovChain.can_preclude`: unknown `next` lets everything through. */
  canPrecede(word: string, next: string): boolean {
    const row = this.backward.get(next)
    return !row || row.has(word)
  }

  /** Weighted bigram count of `prev → next`. */
  bigram(prev: string, next: string): number {
    return this.forward.get(prev)?.get(next) ?? 0
  }

  /** Followers of `prev`, most frequent first. */
  followers(prev: string): Array<[string, number]> {
    const row = this.forward.get(prev)
    if (!row) return []
    return Array.from(row.entries()).sort((a, b) => b[1] - a[1])
  }

  /** Every word, most frequent first. */
  vocabularyByFrequency(): Array<[string, number]> {
    return Array.from(this.freq.entries()).sort((a, b) => b[1] - a[1])
  }
}
