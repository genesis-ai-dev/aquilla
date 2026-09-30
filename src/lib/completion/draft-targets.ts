// Which cells a batch draft should actually translate. (AQU-1424)
//
// Pulled out of ProjectWorkspace's action args, where the same one-line filter
// was written twice — once for "Draft" (a batch-sized slice) and once for
// "Draft all" — because the rule has grown a second clause and getting it wrong
// in one of the two costs the user money: a parked cell left in the list gets AI
// credits spent translating text nobody will read or export, and the draft then
// sits waiting the next time someone shows the cell.
//
// The list this filters comes from the cell store's own `order`, which KEEPS a
// hidden row (that is how nothing is lost by hiding one), so the exclusion
// cannot be inherited from the display list and has to happen here.
//
// Deliberately not "cells the editor is showing": batch drafting has always run
// over the file rather than the viewport, and narrowing it to what is on screen
// would be a different feature.

import { isVisibleCell } from "@/lib/cells/hidden"

/** The minimum a draft target has to look like. Kept structural so the helper
 *  is testable without building a whole `CellData`. */
export interface DraftTargetCell {
  translated: string
  hidden?: boolean
}

/**
 * The untranslated, visible cells of `cells`, in the order given.
 *
 * "Untranslated" is an empty target after trimming — the same test the status
 * bar and the file progress use, so what the button drafts matches what the
 * percentage says is left.
 */
export function draftTargets<T extends DraftTargetCell>(cells: readonly T[]): T[] {
  return cells.filter((cell) => isVisibleCell(cell) && !cell.translated.trim())
}
