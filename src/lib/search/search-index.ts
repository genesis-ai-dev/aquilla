import { tokenizeText } from "./tokenizer"

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

interface IndexedPair extends TranslationPair {
  tokens: Set<string>
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

export class SearchIndex {
  private pairs: Map<string, IndexedPair> = new Map()

  buildFromProject(files: { fileId: string; cells: CellInput[] }[]): void {
    this.pairs.clear()
    for (const file of files) {
      for (const cell of file.cells) {
        if (cell.translated && cell.translated.trim()) {
          this.addPair(cell.id, cell.original, cell.translated, file.fileId)
        }
      }
    }
  }

  addPair(cellId: string, source: string, target: string, fileId: string): void {
    this.pairs.set(cellId, { cellId, source, target, fileId, tokens: new Set(tokenizeText(source)) })
  }

  removePair(cellId: string): void { this.pairs.delete(cellId) }

  search(query: string, limit = 5): ScoredPair[] {
    const cleanQuery = query.trim()
    if (!cleanQuery) return []

    const coverageWeight = 0.5
    const maxRestarts = 2
    const maxBranches = 12
    const results: ScoredPair[] = []
    let queryBranches: string[] = [cleanQuery]
    const usedCellIds = new Set<string>()
    let restartCount = 0

    while (results.length < limit && restartCount <= maxRestarts) {
      if (queryBranches.length === 0) {
        restartCount += 1
        if (restartCount > maxRestarts) break
        queryBranches = [cleanQuery]
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
        const branchTokenSet = new Set(tokenizeText(branchQuery))

        for (const [, pair] of this.pairs) {
          if (usedCellIds.has(pair.cellId)) continue
          const matched: string[] = []
          for (const t of branchTokenSet) { if (pair.tokens.has(t)) matched.push(t) }
          if (matched.length === 0) continue

          const coverage = branchTokenSet.size > 0 ? matched.length / branchTokenSet.size : 0
          const score = coverage * (1 + coverageWeight * coverage)

          if (score > bestScore) {
            bestScore = score
            bestBranchIndex = branchIdx
            bestBranchQuery = branchQuery
            bestSourceText = pair.source
            bestPair = { cellId: pair.cellId, source: pair.source, target: pair.target, fileId: pair.fileId, score, matchedTokens: matched }
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
          if (queryBranches.length >= maxBranches) break
        }
      }
    }

    return results.slice(0, limit)
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
    return (" " + q + " ").replace(` ${c} `, " | ").trim().split("|").map((s) => s.trim()).filter((s) => s.length > 0)
  }
}
