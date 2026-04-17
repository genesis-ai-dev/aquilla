/**
 * Context-Branching Search (SBS: Smart Branched Search)
 *
 * Ported from the desktop Codex app. Repeatedly selects the best-matching
 * pair (by BM25 base score with a coverage boost), removes the longest
 * covered contiguous substring from the query branch, and continues until
 * enough results are found or branches are exhausted. Restarting from the
 * original query lets distinct pairs match the same span when needed.
 *
 * In AB testing against raw TF-IDF / BM25, SBS won ~70% for few-shot
 * translation example retrieval because it rewards coverage of distinct
 * query spans rather than re-ranking the same dense region.
 */

import { tokenizeText } from "./tokenizer"
import { BM25Index } from "./bm25"

export interface TranslationPair {
  cellId: string
  source: string
  target: string
  fileId: string
}

export interface ScoredPair extends TranslationPair {
  score: number
  matchedTokens: string[]
}

interface CellInput {
  id: string
  original: string
  translated: string
  originalHtml?: string
  context: string
  group: string
  type: string
}

const COVERAGE_WEIGHT = 0.5
const MAX_RESTARTS = 2
const MAX_BRANCHES = 12
const CANDIDATES_PER_BRANCH_MULT = 30
const MIN_CANDIDATES_PER_BRANCH = 150

export class ContextBranchingSearchIndex {
  private bm25 = new BM25Index()

  buildFromProject(files: { fileId: string; cells: CellInput[] }[]): void {
    this.bm25.clear()
    for (const file of files) {
      for (const cell of file.cells) {
        if (cell.translated && cell.translated.trim()) {
          this.bm25.addDoc({
            cellId: cell.id,
            source: cell.original,
            target: cell.translated,
            fileId: file.fileId,
          })
        }
      }
    }
  }

  addPair(cellId: string, source: string, target: string, fileId: string): void {
    this.bm25.addDoc({ cellId, source, target, fileId })
  }

  removePair(cellId: string): void {
    this.bm25.removeDoc(cellId)
  }

  search(query: string, limit = 5): ScoredPair[] {
    const originalQuery = query.trim()
    if (!originalQuery) return []
    const cap = Math.max(1, limit)

    const candidatesPerBranch = Math.max(cap * CANDIDATES_PER_BRANCH_MULT, MIN_CANDIDATES_PER_BRANCH)

    const results: ScoredPair[] = []
    let queryBranches: string[] = [originalQuery]
    const usedCellIds = new Set<string>()
    let restartCount = 0

    while (results.length < cap && restartCount <= MAX_RESTARTS) {
      if (queryBranches.length === 0) {
        restartCount += 1
        if (restartCount > MAX_RESTARTS) break
        queryBranches = [originalQuery]
        continue
      }

      let bestScore = -Infinity
      let bestPair: ScoredPair | null = null
      let bestBranchIndex = -1
      let bestBranchQuery = ""
      let bestSourceText = ""

      for (let branchIdx = 0; branchIdx < queryBranches.length; branchIdx++) {
        const branchQuery = queryBranches[branchIdx]
        if (!branchQuery.trim()) continue

        const candidates = this.bm25.search(branchQuery, candidatesPerBranch)
        if (candidates.length === 0) continue

        const branchQueryTokenSet = new Set(tokenizeText(branchQuery))
        if (branchQueryTokenSet.size === 0) continue

        for (const cand of candidates) {
          if (usedCellIds.has(cand.cellId)) continue
          if (!cand.source?.trim() || !cand.target?.trim()) continue

          const { coverage, matched } = this.computeCoverage(branchQueryTokenSet, cand.source)
          const score = cand.score * (1 + COVERAGE_WEIGHT * coverage)

          if (score > bestScore) {
            bestScore = score
            bestBranchIndex = branchIdx
            bestBranchQuery = branchQuery
            bestSourceText = cand.source
            bestPair = {
              cellId: cand.cellId,
              source: cand.source,
              target: cand.target,
              fileId: cand.fileId,
              score,
              matchedTokens: matched,
            }
          }
        }
      }

      if (!bestPair) break

      results.push(bestPair)
      usedCellIds.add(bestPair.cellId)

      const covered = this.findLongestCoveredSubstring(bestBranchQuery, bestSourceText)
      if (bestBranchIndex >= 0) queryBranches.splice(bestBranchIndex, 1)
      if (covered) {
        const newBranches = this.removeSubstringAndSplit(bestBranchQuery, covered)
        for (const nb of newBranches) {
          if (nb && nb !== bestBranchQuery) queryBranches.push(nb)
          if (queryBranches.length >= MAX_BRANCHES) break
        }
      }
    }

    return results.slice(0, cap)
  }

  private computeCoverage(
    queryTokenSet: Set<string>,
    sourceText: string,
  ): { coverage: number; matched: string[] } {
    const sourceTokens = new Set(tokenizeText(sourceText))
    if (queryTokenSet.size === 0) return { coverage: 0, matched: [] }
    const matched: string[] = []
    for (const t of queryTokenSet) if (sourceTokens.has(t)) matched.push(t)
    return { coverage: matched.length / queryTokenSet.size, matched }
  }

  private findLongestCoveredSubstring(queryText: string, sourceText: string): string {
    const queryWords = tokenizeText(queryText)
    const sourceWords = new Set(tokenizeText(sourceText))
    let longest = ""
    for (let i = 0; i < queryWords.length; i++) {
      for (let j = i + 1; j <= queryWords.length; j++) {
        const slice = queryWords.slice(i, j)
        if (slice.every((w) => sourceWords.has(w))) {
          const s = slice.join(" ")
          if (s.length > longest.length) longest = s
        }
      }
    }
    return longest
  }

  private removeSubstringAndSplit(queryText: string, coveredSubstring: string): string[] {
    if (!coveredSubstring) return []
    const q = tokenizeText(queryText).join(" ")
    const c = tokenizeText(coveredSubstring).join(" ")
    return (" " + q + " ")
      .replace(` ${c} `, " | ")
      .trim()
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
}
