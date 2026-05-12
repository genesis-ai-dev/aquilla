import { stripTags } from "./tokenizer"
import type { ExportCell } from "@/lib/store/file-doc"

export type MatchField = "original" | "translated" | "context"

export interface WorkspaceSearchResult {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  matchedFields: Set<MatchField>
  matchCount: number
  /** Lowercased query echoed back for the row-level token highlighter. */
  matchedTokens: string[]
}

export interface SearchOptions {
  fileId?: string
  caseSensitive?: boolean
  limit?: number
}

interface IndexedCell {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  originalLower: string
  translatedLower: string
  contextLower: string
}

/**
 * Plain substring index over (original, translated, context). Each cell
 * caches a casefolded copy so case-insensitive search doesn't reallocate
 * per query. Case-sensitive search reads the raw fields.
 */
export class WorkspaceIndex {
  private cells: IndexedCell[] = []

  buildFromProject(files: { fileId: string; fileName: string; cells: ExportCell[] }[]): void {
    this.cells = []
    for (const file of files) {
      for (const cell of file.cells) {
        const original = stripTags(cell.original)
        const translated = stripTags(cell.translated)
        const context = cell.context ?? ""
        this.cells.push({
          cellId: cell.id,
          fileId: file.fileId,
          fileName: file.fileName,
          original, translated, context,
          originalLower: original.toLowerCase(),
          translatedLower: translated.toLowerCase(),
          contextLower: context.toLowerCase(),
        })
      }
    }
  }

  search(query: string, options: SearchOptions = {}): WorkspaceSearchResult[] {
    const cleaned = query.trim()
    if (!cleaned) return []
    const caseSensitive = !!options.caseSensitive
    const needle = caseSensitive ? cleaned : cleaned.toLowerCase()
    const limit = options.limit ?? 50

    const results: WorkspaceSearchResult[] = []
    for (const cell of this.cells) {
      if (options.fileId && cell.fileId !== options.fileId) continue
      const src = caseSensitive ? cell.original : cell.originalLower
      const tgt = caseSensitive ? cell.translated : cell.translatedLower
      const ctx = caseSensitive ? cell.context : cell.contextLower
      const inSrc = countOccurrences(src, needle)
      const inTgt = countOccurrences(tgt, needle)
      const inCtx = countOccurrences(ctx, needle)
      const total = inSrc + inTgt + inCtx
      if (total === 0) continue
      const matchedFields = new Set<MatchField>()
      if (inSrc) matchedFields.add("original")
      if (inTgt) matchedFields.add("translated")
      if (inCtx) matchedFields.add("context")
      results.push({
        cellId: cell.cellId,
        fileId: cell.fileId,
        fileName: cell.fileName,
        original: cell.original,
        translated: cell.translated,
        context: cell.context,
        matchedFields,
        matchCount: total,
        matchedTokens: [cleaned.toLowerCase()],
      })
      if (results.length >= limit) break
    }
    return results
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}
