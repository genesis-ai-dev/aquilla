import * as Y from "yjs"
import {
  getEditsArray,
  getEntryEditMap,
  upsertValidator,
  softDeleteValidator,
} from "./yjs-helpers"
import { enqueueCellValidateToggle } from "@/lib/sync/cqrs-bridge"

/**
 * Add or remove the current user's validation on the cell's latest
 * value-editMap entry. Only the most recent value-edit is togglable —
 * validations on prior states are historical and immutable.
 *
 * No-op if the cell has no value-edit yet (empty cell can't be validated).
 */
export function toggleCellValidation(
  doc: Y.Doc, cellId: string, username: string, validate: boolean,
  /** See commit-cell-edit.ts for fileIdOverride rationale. */
  fileIdOverride?: string,
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  const now = Date.now()
  let applied = false
  doc.transact(() => {
    const arr = getEditsArray(cell)
    let target: Y.Map<unknown> | undefined
    for (let i = arr.length - 1; i >= 0; i--) {
      const entry = arr.get(i)
      if (getEntryEditMap(entry)[0] === "value") { target = entry; break }
    }
    if (!target) return
    applied = true
    if (validate) upsertValidator(target, username, now)
    else softDeleteValidator(target, username, now)
  })
  if (applied) {
    enqueueCellValidateToggle(cellId, validate, now, fileIdOverride)
  }
}
