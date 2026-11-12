// Which cells are HIDDEN, client-side. (AQU-1424)
//
// "Hide cell" (AQU-1422) parks a cell without deleting anything. AQU-1424 is the
// other half of that promise: a parked cell stops being WORK, so it leaves
// progress, health, drafting and search wherever the app measures or automates
// them. This is the client's half of a predicate whose server copies live in
// `sync-worker/src/events/hidden-cells-scope.ts` and
// `auth-worker/src/lib/hidden-cells-scope.ts`. All three must agree.
//
// It sits beside `src/lib/cells/structural.ts` and is used the same way, but the
// two mean different things and must not be conflated:
//
//   * STRUCTURAL is project POLICY — a heading is still a cell the team may
//     choose to count, so it is excluded from progress and left in the editor.
//   * HIDDEN is a per-cell decision by a person — the row leaves the display
//     list (AQU-1422 does that) AND stops counting (this slice).
//
// WHY A ONE-LINE FUNCTION AND NOT `cell.hidden === true` AT EACH SITE. The trap
// is not the comparison, it is WHICH OBJECT you compare. The flag rides the
// SOURCE row only, because hiding is per cell rather than per lane, and a target
// row created after the hide carries none of its own. Taking the row (or a view
// built from the source row) rather than a boolean keeps the sites honest about
// what they are reading — and it is the one place to fix if the representation
// ever changes.

/** True while this cell is parked with "Hide cell". Absent ⇒ visible, which is
 *  what a pre-AQU-1422 server sends and what a hand-built fixture reads as. */
export function isHiddenCell(cell: { hidden?: boolean } | null | undefined): boolean {
  return cell?.hidden === true
}

/**
 * The inverse, as a predicate you can hand to `Array.prototype.filter` —
 * "the cells that are still work".
 *
 * Reads better than a negated arrow at the call sites that matter most (batch
 * drafting, which is where spending credits on an invisible cell is a bug the
 * user pays for), and keeps the filter from being written four slightly
 * different ways.
 */
export function isVisibleCell<T extends { hidden?: boolean }>(cell: T): boolean {
  return cell.hidden !== true
}
