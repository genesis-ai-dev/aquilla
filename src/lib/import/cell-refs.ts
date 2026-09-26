import type { CellSummary } from "@/hooks/useActiveCellStore"
import type { FileTargetCellRef } from "../import-file-target"

/** Editor summaries use seconds; subtitle import matching uses milliseconds. */
export function fileTargetCellRef(cell: CellSummary): FileTargetCellRef {
  return {
    cellId: cell.id,
    fileId: cell.fileId,
    targetEventId: cell.targetEventId,
    sourceEventId: cell.sourceEventId,
    translated: cell.translated ?? "",
    canonicalRef: cell.group,
    original: cell.original,
    ...(cell.startTime !== undefined && cell.endTime !== undefined
      ? { startMs: Math.round(cell.startTime * 1000), endMs: Math.round(cell.endTime * 1000) }
      : {}),
  }
}
