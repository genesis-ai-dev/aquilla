import { tokenizeText } from "./tokenizer"
import type { ExportCell } from "@/lib/store/file-doc"

export interface WorkspaceSearchResult {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  matchedTokens: string[]
  score: number
}

interface IndexedCell {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  tokens: Set<string>
}

const MIN_SCORE = 0.01

export class WorkspaceIndex {
  private cells: IndexedCell[] = []
  private docFreq: Map<string, number> = new Map()
  private docCount = 0

  buildFromProject(files: { fileId: string; fileName: string; cells: ExportCell[] }[]): void {
    this.cells = []
    this.docFreq.clear()
    this.docCount = 0

    for (const file of files) {
      for (const cell of file.cells) {
        const combined = `${cell.original} ${cell.translated} ${cell.context}`
        const tokens = new Set(tokenizeText(combined))
        this.cells.push({
          cellId: cell.id,
          fileId: file.fileId,
          fileName: file.fileName,
          original: cell.original,
          translated: cell.translated,
          context: cell.context,
          tokens,
        })
        this.docCount += 1
        for (const t of tokens) {
          this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1)
        }
      }
    }
  }

  search(query: string, limit = 20): WorkspaceSearchResult[] {
    const cleaned = query.trim()
    if (!cleaned) return []

    const queryTokens = new Set(tokenizeText(cleaned))
    if (queryTokens.size === 0) return []

    const results: WorkspaceSearchResult[] = []

    for (const cell of this.cells) {
      const matched: string[] = []
      let idfSum = 0
      for (const t of queryTokens) {
        if (cell.tokens.has(t)) {
          matched.push(t)
          const df = this.docFreq.get(t) || 1
          idfSum += Math.log((this.docCount + 1) / (df + 1))
        }
      }
      if (matched.length === 0) continue

      const coverage = matched.length / queryTokens.size
      const maxIdf = queryTokens.size * Math.log((this.docCount + 1) / 2)
      const normalizedIdf = maxIdf > 0 ? idfSum / maxIdf : 0
      const score = 0.3 * coverage + 0.7 * normalizedIdf

      if (score < MIN_SCORE) continue

      results.push({
        cellId: cell.cellId,
        fileId: cell.fileId,
        fileName: cell.fileName,
        original: cell.original,
        translated: cell.translated,
        context: cell.context,
        matchedTokens: matched,
        score,
      })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}
