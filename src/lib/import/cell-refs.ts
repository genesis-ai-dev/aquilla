import type { CellSummary } from "@/hooks/useActiveCellStore"
import { toFileTargetCell, type FileTargetCellRef } from "../import-file-target"

/** Editor summaries use seconds; subtitle import matching uses milliseconds.
 *  Delegates to `toFileTargetCell`, which owns that conversion — there used to
 *  be a second copy here, and the tested copy was not the one the dialog ran. */
export function fileTargetCellRef(cell: CellSummary): FileTargetCellRef {
  return toFileTargetCell(cell)
}
