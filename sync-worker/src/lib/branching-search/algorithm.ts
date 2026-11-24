// AD-13 branching-search algorithm — deterministic cover-the-verse loop over
// character n-grams. Spec: aquilla-specs/02-foundations.md §AD-13; why
// n-grams and not words: docs/decisions/0018-retrieval-covers-text-by-character-ngrams.md
//
// Given verse V: find the corpus cell most similar to V, remove from V every
// part that cell shares with it, search again for the cell most similar to
// what is left, and repeat until nothing of V is left (or `topK` cells are
// found). "Part" is a character n-gram (`../text/char-ngrams`), so the loop
// works the same in a script with no spaces between words.
//
// Pure functions only — no DB, no env, no Workers types. The route handler
// is responsible for loading the corpus + tunables and calling
// `branchingSearch`. Everything here is unit-testable in isolation.
//
// Determinism contract: given the same `query`, `corpus` (same iteration
// order), and `settings`, the output (`results` array order, `provenance`
// map) is byte-identical. AD-14's endorsement bookkeeping depends on this.

import type { BranchingSearchSettings } from "./settings"
import { forEachNgram, normalizeForNgrams, normalizeWithOffsets } from "../text/char-ngrams"

// ─── Public types ───────────────────────────────────────────────────────

/** Input row for the corpus. The route handler fills these from Postgres. */
export interface CorpusCell {
  cellId: string
  sourceText: string
  /** Paired target text. May be empty/null for unfilled cells; included so
   *  the consumer (AI copilot) doesn't have to re-fetch. */
  targetText: string
  /** Whether the cell is validated. Routes may filter on this before calling. */
  validated?: boolean
  /** Source-side file id. Populated by `loadCorpus`; used by the passages
   *  route for ±radius expansion. The ranking algorithm ignores it and only
   *  copies it onto the result (AQU-1393). */
  fileId?: string
  /** Anchor-chain pointer (predecessor cell in the file's anchor chain).
   *  Populated by `loadCorpus`; used by the passages route to walk the
   *  chain. Ranking algorithm ignores it. */
  anchorCellId?: string | null
}

export interface BranchingSearchResult {
  cellId: string
  sourceText: string
  targetText: string
  /** Fraction of the FULL original query's distinct character n-grams
   *  present in this result's source. [0, 1]. Computed against the original
   *  query, not what was left of it when this cell was picked — callers want
   *  "how much of what I asked about does this cell cover" semantics. */
  queryCoverage: number
  /** The file the hit's SOURCE cell lives in, when the corpus carried one
   *  (AQU-1393) — the editor names it as the match's origin. For a linked
   *  target this is the upstream project's file, which the caller's own file
   *  inventory will not contain. */
  fileId?: string
}

/** cellId → the pieces of the query, quoted from the query text as typed,
 *  that this result covered (what was removed from the query when the result
 *  was picked). One entry per contiguous stretch, in query order. */
export type Provenance = Map<string, string[]>

// ─── Corpus pass (once per request) ──────────────────────────────────────

/** A corpus cell that shares at least one n-gram with the query. Cells that
 *  share none can never score, so they are dropped up front. */
interface Candidate {
  cell: CorpusCell
  /** N-gram count of the cell's source — BM25's document length. */
  length: number
  /** The query n-grams this cell contains. */
  shares: ReadonlySet<number>
}

interface Posting {
  candidate: number
  tf: number
}

interface PreparedCorpus {
  candidates: Candidate[]
  /** query n-gram → the candidates containing it, in corpus order. */
  postings: Map<number, Posting[]>
  /** query n-gram → BM25 IDF. */
  idf: Map<number, number>
  avgLength: number
}

function prepareCorpus(
  corpus: readonly CorpusCell[],
  queryGrams: ReadonlySet<number>,
): PreparedCorpus {
  const candidates: Candidate[] = []
  const postings = new Map<number, Posting[]>()
  let totalLength = 0
  const tf = new Map<number, number>()
  for (const cell of corpus) {
    let length = 0
    tf.clear()
    forEachNgram(normalizeForNgrams(cell.sourceText), (key) => {
      length++
      if (queryGrams.has(key)) tf.set(key, (tf.get(key) ?? 0) + 1)
    })
    totalLength += length
    if (tf.size === 0) continue
    const index = candidates.length
    candidates.push({ cell, length, shares: new Set(tf.keys()) })
    for (const [key, count] of tf) {
      let list = postings.get(key)
      if (!list) postings.set(key, (list = []))
      list.push({ candidate: index, tf: count })
    }
  }
  const numDocs = corpus.length
  const idf = new Map<number, number>()
  for (const [key, list] of postings) {
    // Okapi BM25 IDF (Robertson-Spärck-Jones, smoothed). The `+ 1` inside
    // log keeps it positive even for an n-gram in most of the corpus.
    idf.set(key, Math.log((numDocs - list.length + 0.5) / (list.length + 0.5) + 1))
  }
  return { candidates, postings, idf, avgLength: numDocs > 0 ? totalLength / numDocs : 0 }
}

// ─── Main: cover the query ───────────────────────────────────────────────

/**
 * Deterministic branching search over the project's source-cell corpus.
 *
 * Each step scores every unpicked cell against what is left of the query —
 * the n-grams that still hold at least one uncovered character — with Okapi
 * BM25 boosted by the fraction of those n-grams the cell has
 * (`bm25 * (1 + coverageWeight * coverage)`), picks the best, and marks every
 * character of every remaining n-gram that cell shares as covered. The step
 * repeats until the query is covered, nothing scores, or `topK` cells are
 * picked. When the query is covered with slots still open, the search starts
 * over on the whole query (excluding the cells already picked) up to
 * `maxRestarts` times, so near-duplicates of the verse fill the remaining
 * slots.
 *
 * Determinism: ties go to the earlier cell in `corpus` order (strict `>`),
 * and every sum runs in query order, so the same query, corpus order and
 * settings give byte-identical results and provenance.
 */
export function branchingSearch(
  query: string,
  corpus: readonly CorpusCell[],
  settings: BranchingSearchSettings,
): { results: BranchingSearchResult[]; provenance: Provenance } {
  const provenance: Provenance = new Map()
  const q = normalizeWithOffsets(query)
  const n = q.text.length
  if (n === 0 || corpus.length === 0) return { results: [], provenance }

  // A space is never something to cover — only letters, marks and digits.
  const content = new Uint8Array(n)
  for (let i = 0; i < n; i++) content[i] = q.text[i] === " " ? 0 : 1
  const keys: number[] = []
  const starts: number[] = []
  const lengths: number[] = []
  forEachNgram(q.text, (key, start, length) => {
    keys.push(key)
    starts.push(start)
    lengths.push(length)
  })
  const queryGrams = new Set(keys)

  const { candidates, postings, idf, avgLength } = prepareCorpus(corpus, queryGrams)
  if (candidates.length === 0) return { results: [], provenance }

  const { bm25K1: k1, bm25B: b } = settings
  const lengthNorm = candidates.map((c) => 1 - b + b * (c.length / (avgLength || 1)))
  const score = new Float64Array(candidates.length)
  const shared = new Int32Array(candidates.length)
  const picked = new Uint8Array(candidates.length)
  const covered = new Uint8Array(n)

  const results: BranchingSearchResult[] = []
  let restartsLeft = settings.maxRestarts

  while (results.length < settings.topK) {
    covered.fill(0)
    let pickedThisRound = 0

    while (results.length < settings.topK) {
      // What is left of the query: n-gram positions still holding an
      // uncovered character. An n-gram repeated in what is left counts once
      // per occurrence, as a repeated word did.
      const remaining: number[] = []
      const remainingCount = new Map<number, number>()
      for (let g = 0; g < keys.length; g++) {
        for (let i = starts[g]; i < starts[g] + lengths[g]; i++) {
          if (content[i] && !covered[i]) {
            remaining.push(g)
            remainingCount.set(keys[g], (remainingCount.get(keys[g]) ?? 0) + 1)
            break
          }
        }
      }
      if (remainingCount.size === 0) break

      score.fill(0)
      shared.fill(0)
      for (const [key, count] of remainingCount) {
        const list = postings.get(key)
        if (!list) continue
        const termIdf = idf.get(key) ?? 0
        for (const { candidate, tf } of list) {
          if (picked[candidate]) continue
          score[candidate] += count * termIdf * ((tf * (k1 + 1)) / (tf + k1 * lengthNorm[candidate]))
          shared[candidate]++
        }
      }

      let best = -1
      let bestScore = 0
      for (let c = 0; c < candidates.length; c++) {
        if (picked[c] || score[c] === 0) continue
        const combined =
          score[c] * (1 + settings.coverageWeight * (shared[c] / remainingCount.size))
        if (combined > bestScore) {
          bestScore = combined
          best = c
        }
      }
      if (best === -1) break

      // Remove from the query everything the picked cell shares with it.
      const { cell, shares } = candidates[best]
      const newly = new Uint8Array(n)
      for (const g of remaining) {
        if (!shares.has(keys[g])) continue
        for (let i = starts[g]; i < starts[g] + lengths[g]; i++) {
          if (content[i] && !covered[i]) newly[i] = 1
        }
      }
      for (let i = 0; i < n; i++) if (newly[i]) covered[i] = 1

      picked[best] = 1
      pickedThisRound++
      results.push({
        cellId: cell.cellId,
        sourceText: cell.sourceText,
        targetText: cell.targetText,
        queryCoverage: shares.size / queryGrams.size,
        ...(cell.fileId ? { fileId: cell.fileId } : {}),
      })
      provenance.set(cell.cellId, coveredPieces(q, content, newly))
    }

    if (results.length >= settings.topK) break
    // A round that found nothing will not find anything on a restart either.
    if (pickedThisRound === 0 || restartsLeft <= 0) break
    restartsLeft--
  }

  return { results, provenance }
}

/** The stretches of the query text a step covered, quoted from the query as
 *  typed. Stretches separated only by spaces or punctuation are one piece. */
function coveredPieces(
  q: ReturnType<typeof normalizeWithOffsets>,
  content: Uint8Array,
  newly: Uint8Array,
): string[] {
  const pieces: string[] = []
  let first = -1
  let last = -1
  const flush = () => {
    if (first === -1) return
    const piece = q.source.slice(q.start[first], q.end[last]).trim()
    if (piece) pieces.push(piece)
    first = -1
    last = -1
  }
  for (let i = 0; i < q.text.length; i++) {
    if (newly[i]) {
      if (first === -1) first = i
      last = i
    } else if (content[i]) {
      flush()
    }
  }
  flush()
  return pieces
}
