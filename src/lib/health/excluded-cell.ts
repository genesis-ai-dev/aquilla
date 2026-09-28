// Which cells the health ribbon draws as "not counted". (AQU-1083, AQU-1424)
//
// The ribbon and the chapter grid still draw a square for these cells — jumping
// to the chapter still lands on them and the row is still there — so this only
// decides the COLOUR and what the square announces. The FRACTION beside the
// chapter name is the cell store's business, and it applies the same two rules;
// the pair has to agree, or the ribbon paints an outstanding job next to a
// chapter that reads 100%.
//
// TWO RULES, deliberately separate:
//
//   * STRUCTURAL (AQU-1083) is project POLICY. A heading is a real cell that
//     some teams translate and count; the project says whether it counts.
//   * HIDDEN (AQU-1424) is a person parking one row. It never counts, whatever
//     the structural policy says — a project that counts headings still does not
//     count a heading someone hid.
//
// Collapsing them into one condition is the bug this module exists to prevent:
// `!countStructural && (isStructural || isHidden)` reads almost identically and
// silently counts every parked cell on a project that counts headings.

import { isHiddenCell } from "@/lib/cells/hidden"
import { isStructuralCell } from "@/lib/cells/structural"

/** What the ribbon needs off a cell summary to answer the question. */
export interface ExcludedCellInput {
  type?: string
  hidden?: boolean
}

/**
 * True when this cell is not a unit of work, so the ribbon should show it as
 * excluded rather than as something still to do.
 *
 * A missing summary (a cell that vanished between the navigation walk and this
 * read) reads as NOT excluded: the safe answer is the one that keeps drawing the
 * square the way it was drawn before.
 */
export function isExcludedFromWork(
  cell: ExcludedCellInput | null | undefined,
  countStructural: boolean,
): boolean {
  if (isHiddenCell(cell)) return true
  return !countStructural && isStructuralCell(cell?.type)
}
