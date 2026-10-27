// AQU-2176 — naming the rows a repetition validation signed off.
//
// The toast said "Validated N repeated rows" and vanished after ten seconds,
// so a reviewer who had rows signed off on their behalf could not see WHICH
// rows those were. The dialog that replaced it names them, and this module
// builds what it names: pure, so the naming rules are testable without a
// cell store, an editor or a dialog.
//
// WHY THE NUMBER IS A POSITION, not the editor's gutter string. The gutter
// label is EditorTable's (`cellNumberLabel` over its display list and
// structure cache) and is not reachable from the hook that writes these
// events. A 1-based position among the file's VISIBLE cells is the same
// number in the sequential case, and where it is not — scripture numbering —
// the reference beside it ("GEN 1:1") is what the gutter shows anyway. Same
// convention as the conflict dialog's `editor.repetition.conflictRowName`.

import { fmtCueClock } from "@/components/timeline/format"
import { namedCellRef } from "@/lib/cell-named-ref"
import { isVisibleCell } from "@/lib/cells/hidden"

/** The shape this module needs of a row; a `CellData` satisfies it. */
export interface ValidatedRowCell {
  id: string
  translated?: string
  hidden?: boolean
  context?: string | null
  globalReferences?: readonly string[] | null
  startTime?: number
}

/** One row the dialog names. */
export interface ValidatedRepetitionRow {
  cellId: string
  /** Its position in the file, as the gutter numbers it. "" when unknown. */
  number: string
  /** Its reference ("GEN 1:1") or timecode, where the row has one. */
  ref: string | null
  /** The translation it now holds. */
  text: string
}

/**
 * The row's reference as a person reads it: its canonical/global reference,
 * else its timecode on a media row, else nothing. A row that has neither is
 * named by its number alone.
 */
export function validatedRowRef(cell: ValidatedRowCell): string | null {
  const named = namedCellRef(cell)
  if (named) return named
  const start = cell.startTime
  return typeof start === "number" && Number.isFinite(start) ? fmtCueClock(start) : null
}

/**
 * Describe `cellIds` for the dialog, in the order they appear in the file —
 * the order the reviewer will scroll through them, not the order the planner
 * happened to visit.
 *
 * `filledWith` carries the text a fill just wrote: the optimistic patch has
 * landed by the time this runs, but reading the write back from the store
 * would make the list depend on that timing, and a row that received no fill
 * (an identical repeat that only needed the vote) has no entry there at all.
 */
export function describeValidatedRepetitionRows(
  cellIds: readonly string[],
  cells: readonly ValidatedRowCell[],
  filledWith: ReadonlyMap<string, string>,
): ValidatedRepetitionRow[] {
  const visible = cells.filter(isVisibleCell)
  const position = new Map(visible.map((cell, index) => [cell.id, index + 1]))
  const byId = new Map(cells.map((cell) => [cell.id, cell]))
  return [...new Set(cellIds)]
    .sort((a, b) => (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER))
    .map((cellId) => {
      const cell = byId.get(cellId)
      const number = position.get(cellId)
      return {
        cellId,
        number: number === undefined ? "" : String(number),
        ref: cell ? validatedRowRef(cell) : null,
        text: (filledWith.get(cellId) ?? cell?.translated ?? "").trim(),
      }
    })
}
