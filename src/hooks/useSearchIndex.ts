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

  const search = useCallback((query: string, limit?: number): ScoredPair[] => {
    return indexRef.current.searchBranchingSource(query, limit ?? 5)
  }, [])

  return { search, index: indexRef.current }
}
