// AD-13 branching-search algorithm — deterministic BM25 + iterative
// coverage/branch loop. Spec: aquilla-specs/02-foundations.md §AD-13.
//
// Pure functions only — no DB, no env, no Workers types. The route handler
// is responsible for loading the corpus + tunables and calling
// `branchingSearch`. Everything here is unit-testable in isolation.
//
// Determinism contract: given the same `query`, `corpus` (same iteration
// order), and `settings`, the output (`results` array order, `provenance`
// map) is byte-identical. AD-14's endorsement bookkeeping depends on this.

import type { BranchingSearchSettings } from "./settings"

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
   *  route for ±radius expansion. The ranking algorithm ignores it. */
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
  /** Fraction of the FULL original query's unique words present in this
   *  result's bag-of-words. [0, 1]. Computed against the original query,
   *  not the winning sub-branch — callers want "how much of what I asked
   *  about does this cell cover" semantics. */
  queryCoverage: number
}

/** cellId → the contiguous slice of the winning branch that this result
 *  satisfied (i.e., the substring removed from the branch when this result
 *  was selected). Empty array for safety-bailout cases (shouldn't happen
 *  with bm25 > 0). */
export type Provenance = Map<string, string[]>

// ─── Tokenization ────────────────────────────────────────────────────────

/**
 * Lowercase, drop punctuation, split on whitespace. Uses Unicode property
 * escapes (\p{L}, \p{N}) so it keeps letters from any script.
 *
 * CJK / abjads without explicit spacing are flagged `tentative` in the
 * spec — v1 just whitespace-tokenizes them and accepts the degradation.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

// ─── Corpus stats (computed once per request) ────────────────────────────

interface TokenizedCell extends CorpusCell {
  tokens: string[]
  termCounts: Map<string, number>
  /** Unique tokens — used for "is this branch word in the cell's bag?". */
  bag: Set<string>
}

export interface CorpusStats {
  numDocs: number
  avgDocLength: number
  /** term → number of docs containing the term (df). */
  docFrequency: Map<string, number>
}

function tokenizeCorpus(corpus: readonly CorpusCell[]): TokenizedCell[] {
  return corpus.map((c) => {
    const tokens = tokenize(c.sourceText)
    const termCounts = new Map<string, number>()
    for (const t of tokens) {
      termCounts.set(t, (termCounts.get(t) ?? 0) + 1)
    }
    return {
      cellId: c.cellId,
      sourceText: c.sourceText,
      targetText: c.targetText,
      validated: c.validated,
      tokens,
      termCounts,
      bag: new Set(tokens),
    }
  })
}

function computeCorpusStats(corpus: readonly TokenizedCell[]): CorpusStats {
  const numDocs = corpus.length
  let totalLen = 0
  const docFrequency = new Map<string, number>()
  for (const cell of corpus) {
    totalLen += cell.tokens.length
    for (const t of cell.bag) {
      docFrequency.set(t, (docFrequency.get(t) ?? 0) + 1)
    }
  }
  return {
    numDocs,
    avgDocLength: numDocs > 0 ? totalLen / numDocs : 0,
    docFrequency,
  }
}

// ─── BM25 + coverage scoring ─────────────────────────────────────────────

/** Narrow shape `bm25Score` needs from a doc — lets tests synthesize one
 *  without the CorpusCell payload fields. */
export interface BM25Doc {
  tokens: readonly string[]
  termCounts: ReadonlyMap<string, number>
}

/**
 * Okapi BM25 score of `branch` against `doc`, with corpus stats `stats`.
 * Iterates over branch tokens with multiplicity — the same token repeated
 * in the branch contributes its score multiple times. (After the first
 * branching iteration, the branch shrinks and duplicates are naturally
 * pruned, so this matters mostly for the seed query.)
 *
 * Returns 0 when there's no token overlap.
 */
export function bm25Score(
  branch: readonly string[],
  doc: BM25Doc,
  stats: CorpusStats,
  k1: number,
  b: number,
): number {
  if (branch.length === 0 || doc.tokens.length === 0 || stats.numDocs === 0) {
    return 0
  }
  let score = 0
  const docLen = doc.tokens.length
  const lenNorm = 1 - b + b * (docLen / (stats.avgDocLength || 1))
  for (const term of branch) {
    const tf = doc.termCounts.get(term) ?? 0
    if (tf === 0) continue
    const df = stats.docFrequency.get(term) ?? 0
    // Okapi BM25 IDF (Robertson-Spärck-Jones, smoothed). The `+ 1` inside
    // log keeps the term positive even when df is more than half the corpus.
    const idf = Math.log((stats.numDocs - df + 0.5) / (df + 0.5) + 1)
    const numerator = tf * (k1 + 1)
    const denominator = tf + k1 * lenNorm
    score += idf * (numerator / denominator)
  }
  return score
}

/** Fraction of unique branch words present in the candidate's bag. [0, 1]. */
export function coverageRatio(branch: readonly string[], docBag: ReadonlySet<string>): number {
  if (branch.length === 0) return 0
  const uniqueBranch = new Set(branch)
  if (uniqueBranch.size === 0) return 0
  let covered = 0
  for (const t of uniqueBranch) {
    if (docBag.has(t)) covered++
  }
  return covered / uniqueBranch.size
}

// ─── Branching: longest contiguous run + split ───────────────────────────

interface Run {
  start: number
  length: number
}

/**
 * Longest contiguous slice of `branch` where every token is in `docBag`.
 * Spec wording: "longest run of branch words (contiguous in the branch)
 * all of which appear in the candidate's source (bag-of-words within the
 * candidate)".
 *
 * Linear scan; on ties, the EARLIEST run wins (stable for determinism).
 * Returns `{start: 0, length: 0}` when no branch token is in the bag.
 */
export function longestContiguousRun(
  branch: readonly string[],
  docBag: ReadonlySet<string>,
): Run {
  let bestStart = 0
  let bestLen = 0
  let curStart = 0
  let curLen = 0
  for (let i = 0; i < branch.length; i++) {
    if (docBag.has(branch[i])) {
      if (curLen === 0) curStart = i
      curLen++
      if (curLen > bestLen) {
        bestStart = curStart
        bestLen = curLen
      }
    } else {
      curLen = 0
    }
  }
  return { start: bestStart, length: bestLen }
}

/** Remove the slice `[run.start, run.start + run.length)` from `branch` and
 *  split the remainder into up to two sub-branches (omitting empty pieces). */
export function removeRunAndSplit(
  branch: readonly string[],
  run: Run,
): string[][] {
  const left = branch.slice(0, run.start)
  const right = branch.slice(run.start + run.length)
  const out: string[][] = []
  if (left.length > 0) out.push(left)
  if (right.length > 0) out.push(right)
  return out
}

// ─── Main: iterative branching search ────────────────────────────────────

/**
 * Deterministic branching search over the project's source-cell corpus.
 * See `AD-13` in `02-foundations.md` for the algorithm.
 *
 * Stops when `settings.topK` results are collected, or all branches run
 * out across `settings.maxRestarts + 1` seed attempts.
 *
 * Score tiebreaker: strict `>`, so the first equally-best (branch, cell)
 * pair in scan order wins. As long as the input `corpus` order is stable
 * and the branches array's internal order is preserved (it is — we
 * `splice` winning branches in place), the output is deterministic.
 */
export function branchingSearch(
  query: string,
  corpus: readonly CorpusCell[],
  settings: BranchingSearchSettings,
): { results: BranchingSearchResult[]; provenance: Provenance } {
  const queryTokens = tokenize(query)
  const provenance: Provenance = new Map()
  if (queryTokens.length === 0 || corpus.length === 0) {
    return { results: [], provenance }
  }

  const tokenizedCorpus = tokenizeCorpus(corpus)
  const stats = computeCorpusStats(tokenizedCorpus)

  const results: BranchingSearchResult[] = []
  const selectedCellIds = new Set<string>()

  let restartsLeft = settings.maxRestarts

  // Outer loop: seed → drain → maybe restart.
  // Loop guard: results.length < topK AND restartsLeft >= 0 at entry.
  while (results.length < settings.topK) {
    const branches: string[][] = [queryTokens.slice()]

    while (results.length < settings.topK && branches.length > 0) {
      let bestScore = 0
      let bestBranchIdx = -1
      let bestCell: TokenizedCell | null = null

      for (let bi = 0; bi < branches.length; bi++) {
        const branch = branches[bi]
        if (branch.length === 0) continue
        for (const cell of tokenizedCorpus) {
          if (selectedCellIds.has(cell.cellId)) continue
          const bm25 = bm25Score(branch, cell, stats, settings.bm25K1, settings.bm25B)
          if (bm25 === 0) continue
          const cov = coverageRatio(branch, cell.bag)
          const combined = bm25 * (1 + settings.coverageWeight * cov)
          if (combined > bestScore) {
            bestScore = combined
            bestBranchIdx = bi
            bestCell = cell
          }
        }
      }

      if (bestBranchIdx === -1 || bestCell === null) break

      const winningBranch = branches[bestBranchIdx]
      const run = longestContiguousRun(winningBranch, bestCell.bag)
      if (run.length === 0) {
        // Defensive: bm25 > 0 implies at least one shared token, so this
        // shouldn't fire. If it does, drop the branch to avoid an infinite
        // loop and continue without recording a result for this cell.
        branches.splice(bestBranchIdx, 1)
        continue
      }

      const runTokens = winningBranch.slice(run.start, run.start + run.length)
      results.push({
        cellId: bestCell.cellId,
        sourceText: bestCell.sourceText,
        targetText: bestCell.targetText,
        queryCoverage: coverageRatio(queryTokens, bestCell.bag),
      })
      selectedCellIds.add(bestCell.cellId)
      provenance.set(bestCell.cellId, runTokens)

      const subBranches = removeRunAndSplit(winningBranch, run)
      branches.splice(bestBranchIdx, 1, ...subBranches)
    }

    if (results.length >= settings.topK) break
    if (restartsLeft <= 0) break
    restartsLeft--
  }

  return { results, provenance }
}
