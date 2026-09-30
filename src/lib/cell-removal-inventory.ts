// AQU-1068: what a person is actually destroying when they remove a cell.
//
// Removal used to be restricted to an EMPTY line somebody had added by hand,
// so there was nothing to warn about and no dialog at all. Now a maintainer can
// take out an imported cell, and an imported cell is exactly the one carrying
// translations in several languages, recordings, comments and validations —
// none of which the person clicking the button can see from the row.
//
// Sam, 2026-08-29, choosing this over blocking removal until the cell is empty:
// the confirmation lists exactly what will go, and one confirm destroys it all.
// That trade only holds if the list is HONEST, which is what this module is
// for. It counts from the same data the surfaces already have — no fetch — so
// the dialog cannot say something different from the table behind it.

import { audioIdSeededWith } from "@/lib/audio/upload"
import { readImportMilestone } from "@/lib/milestone-navigation"
import type { CellData } from "@/hooks/useCells"

export interface CellRemovalInventory {
  /** Target-language lanes holding a translation of this cell. */
  laneCount: number
  /** Recordings that belong to THIS cell (not a clip shared across a file). */
  takeCount: number
  /** Comment threads and replies anchored to this cell, resolved or not. */
  commentCount: number
  /** People whose validation vote stands on this cell. */
  validatorCount: number
  /** A take here also performs other lines, so removing this cell is not local. */
  hasSharedTake: boolean
  /** The chapter/section heading this row carries, if it carries one — losing
   *  the cell loses the heading from chapter navigation. */
  milestoneLabel: string | null
  /** Nothing attached: the take-back case, which needs no confirmation. */
  isEmpty: boolean
}

export interface RemovalInventoryInput {
  cell: CellData
  /** From `cellStore.getRemovalPlan(...).targetLangs`. */
  targetLangs: readonly string[]
  /** Every comment on this cell — roots AND replies, resolved included.
   *  Deliberately not the "open threads" count the row badge shows: a resolved
   *  thread is still a thing that disappears. */
  commentCount: number
  /** Takes that also perform other lines (`sharedWith > 1` on a linked take). */
  sharedTakeCount?: number
}

export function buildCellRemovalInventory({
  cell,
  targetLangs,
  commentCount,
  sharedTakeCount = 0,
}: RemovalInventoryInput): CellRemovalInventory {
  // `audioIdSeededWith` is what separates a take OF THIS CELL from the imported
  // clip a whole file shares — counting the latter would tell someone they are
  // about to destroy a recording that every other row also uses.
  let takeCount = 0
  for (const [audioId, att] of Object.entries(cell.attachments ?? {})) {
    if (att.isDeleted) continue
    if (audioIdSeededWith(audioId, cell.id)) takeCount++
  }

  const validatorCount = cell.activeValidators?.length ?? 0
  const laneCount = targetLangs.length
  const milestone = readImportMilestone(cell.metadata)

  return {
    laneCount,
    takeCount,
    commentCount,
    validatorCount,
    hasSharedTake: sharedTakeCount > 0,
    milestoneLabel: milestone?.label ?? null,
    isEmpty:
      laneCount === 0 &&
      takeCount === 0 &&
      commentCount === 0 &&
      validatorCount === 0 &&
      !cell.original?.trim() &&
      !cell.transcription?.trim(),
  }
}
