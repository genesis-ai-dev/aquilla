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
 *     text file; tokenization matches the shared Unicode tokenizer
 *     (`completion/tokenize.ts`), so any script works, including scripts that
 *     point vowels with combining marks. Words are keyed lower-case (as the
 *     Python lower-cased the corpus) but the most common surface spelling is
 *     kept for display, so a suggestion reads "Dios", not "dios".
 *   - Bigrams never cross a cell boundary (the Python chained the whole corpus).
 *   - Every cell carries a weight: validated cells count 1, unvalidated
 *     target cells count FALLBACK_WEIGHT. Counts are weight sums.
 *   - The index is incremental: `upsert` / `remove` adjust every table in
 *     O(tokens in the cell), so an edit never rebuilds the corpus.
 *
 * Pure, synchronous, no DOM — runs in a Web Worker or a test.
 */

import { SourceLexicon } from "./source-lexicon"

/** Same token class as `completion/tokenize.ts`, without lower-casing. */
const TOKEN_RE = /[\p{L}\p{N}\p{M}]+/gu

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

export class BiaIndex {
  private readonly cells = new Map<string, IndexedCell>()
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
  private nextOrder = 0
  /** Source-side lexicon over the same cells (see source-lexicon.ts). */
  readonly lexicon: SourceLexicon = new SourceLexicon({
    target: (id) => this.cells.get(id),
    targetDf: (word) => this.postings.get(word)?.size ?? 0,
  })

  /** Number of indexed cells (the IDF `n`). */
  get size(): number {
    return this.cells.size
  }

  /** Add or replace cells. Empty text removes the cell's target (its source stays). */
  upsert(cells: readonly ForecastCell[]): void {
    for (const cell of cells) {
      this.lexicon.remove(cell.id)
      this.removeOne(cell.id)
      const surface = Array.from(cell.text.matchAll(TOKEN_RE), (m) => m[0])
      const tokens = surface.map((t) => t.toLowerCase())
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
    this.forward.clear()
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
      if (pos > 0) {
        const prev = tokens[pos - 1]
        bump(this.forward, prev, word, sign * weight)
        bump(this.backward, word, prev, sign * weight)
      }
    })
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
