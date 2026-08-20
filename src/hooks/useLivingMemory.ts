/** Aggregate validated cells across the complete project corpus. */

import { useCallback, useMemo } from "react"
import type { CellData } from "@/hooks/useCells"
import { useProjectCells } from "@/hooks/useProjectCells"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import type { ProjectRecord } from "@/lib/parsers/types"

/** Return only cells that have been validated. */
export function filterValidated(cells: CellData[]): CellData[] {
  return cells.filter((cell) => cell.status === "validated")
}

/** Sort validated cells by recency, then a deterministic reference/id key. */
export function sortValidated<T extends CellData>(cells: T[]): T[] {
  return [...cells].sort((a, b) => {
    const at = a.lastEditAt ?? 0
    const bt = b.lastEditAt ?? 0
    if (bt !== at) return bt - at
    const ag = a.group || a.id
    const bg = b.group || b.id
    if (ag < bg) return -1
    if (ag > bg) return 1
    return 0
  })
}

export interface LivingMemoryCell extends CellData {
  /** The human-readable file name the cell belongs to. */
  fileName: string
}

export interface UseLivingMemoryResult {
  cells: LivingMemoryCell[]
  isLoading: boolean
  isEmpty: boolean
  /** Backward-compatible field; complete project reads are never truncated. */
  isTruncated: boolean
  fileCount: number
  error?: Error
}

export function useLivingMemory({
  projectId,
  project,
  enabled = true,
}: {
  projectId: string
  /** The calling surface already owns project loading. Keeping that ownership
   * here avoids a second project resolve before the corpus query can start. */
  project: ProjectRecord | null
  /** Validated examples are expensive: every project file is read. Callers
   * should enable this only while a surface actually consumes those cells. */
  enabled?: boolean
}): UseLivingMemoryResult {
  const { session } = useFrontierSession()
  const jwt = session?.jwt
  const projectFiles = useMemo(
    () => (project?.files ?? []).map((file) => ({ id: file.id, name: file.name, type: file.type })),
    [project?.files],
  )

  const getToken = useCallback((fileId: string): Promise<string | null> => {
    if (!projectId || !jwt) {
      return Promise.resolve(null)
    }
    return buildFileScopedTokenFetcher(() => jwt, projectId)(fileId)
  }, [jwt, projectId])

  const {
    files,
    isLoading: projectCellsLoading,
    error,
  } = useProjectCells({
    projectId,
    projectFiles,
    getToken,
    enabled: enabled && Boolean(project) && Boolean(jwt),
  })

  const cells = useMemo(() => {
    const validated: LivingMemoryCell[] = []
    for (const file of files) {
      for (const cell of filterValidated(file.cells)) {
        validated.push({ ...cell, fileName: file.fileName })
      }
    }
    return sortValidated(validated)
  }, [files])

  const isLoading = enabled && (project == null || projectCellsLoading)
  return {
    cells,
    isLoading,
    isEmpty: enabled && !isLoading && !error && cells.length === 0,
    isTruncated: false,
    fileCount: projectFiles.length,
    error,
  }
}
