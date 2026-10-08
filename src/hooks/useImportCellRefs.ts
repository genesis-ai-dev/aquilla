import { useMemo } from "react"
import { fileTargetCellRef } from "@/lib/import/cell-refs"
import type { CellSummary } from "./useActiveCellStore"
import type { SourceCellRef } from "@/lib/import"
import type { FileTargetCellRef } from "@/lib/import-file-target"

const EMPTY_SOURCE_REFS: SourceCellRef[] = []
const EMPTY_TARGET_REFS: FileTargetCellRef[] = []

/** Closed import dialogs need neither whole-file allocations nor changing
 * props. Open dialogs always derive from the current file/lane summaries,
 * including current event heads for safe commit parents. The Import dialog
 * needs both shapes while open: source refs for eBible's target mode and
 * Paired translation, target refs for its translation review (AQU-1365).
 */
export function useImportCellRefs(
  cells: readonly CellSummary[],
  importOpen: boolean,
) {
  const importSourceCells = useMemo(() => importOpen ? cells.map((cell) => ({
    cellId: cell.id,
    fileId: cell.fileId,
    targetEventId: cell.targetEventId,
    sourceEventId: cell.sourceEventId,
    translated: cell.translated ?? "",
    canonicalRef: cell.group,
  })) : EMPTY_SOURCE_REFS, [cells, importOpen])

  const fileTargetCells = useMemo(() => importOpen ? cells.map(fileTargetCellRef) : EMPTY_TARGET_REFS, [cells, importOpen])

  return { importSourceCells, fileTargetCells }
}
