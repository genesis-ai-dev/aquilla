import { useEffect, useRef, useCallback } from "react"
import { DualIndex, type ScoredPair } from "@/lib/search/dual-index"
import type { FileReference } from "@/lib/parsers/types"
import type { CellData } from "./useCells"

/**
 * Builds a project-wide DualIndex from all cells across all files. The index is
 * kept hot and updated on every change; callers get a stable `search` callback
 * that runs the branching search on the source side (matching the legacy
 * `SearchIndex.search` behavior used for few-shot completion retrieval).
 */
export function useSearchIndex(_files: FileReference[], allProjectCells: CellData[]) {
  const indexRef = useRef(new DualIndex())

  useEffect(() => {
    indexRef.current.buildFromProject(
      allProjectCells.map((c) => ({
        id: c.id,
        original: c.original,
        translated: c.translated,
        fileId: c.fileId,
      })),
    )
  }, [allProjectCells])

  // `excludeId` skips a specific cell from the result — used by completion to
  // keep the cell-being-translated out of its own few-shot examples (otherwise
  // a re-completion of an already-translated cell sees its own (source, target)
  // pair and the model just echoes the existing translation back).
  const search = useCallback((query: string, limit = 5, excludeId?: string): ScoredPair[] => {
    if (!excludeId) return indexRef.current.searchBranchingSource(query, limit)
    const raw = indexRef.current.searchBranchingSource(query, limit + 1)
    const filtered = raw.filter((p) => p.cellId !== excludeId)
    return filtered.length > limit ? filtered.slice(0, limit) : filtered
  }, [])

  return { search, index: indexRef.current }
}
