import { useEffect, useRef, useCallback } from "react"
import { SearchIndex, type ScoredPair } from "@/lib/search/search-index"
import type { FileReference } from "@/lib/parsers/types"
import type { CellData } from "./useCells"

export function useSearchIndex(_files: FileReference[], currentCells: CellData[]) {
  const indexRef = useRef(new SearchIndex())

  useEffect(() => {
    if (currentCells.length > 0) {
      indexRef.current.buildFromProject([{ fileId: "current", cells: currentCells }])
    }
  }, [currentCells])

  const search = useCallback((query: string, limit?: number): ScoredPair[] => {
    return indexRef.current.search(query, limit)
  }, [])

  return { search, index: indexRef.current }
}
