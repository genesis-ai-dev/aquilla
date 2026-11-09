// AQU-2432 (Sam, Nov 9, rule 8): THE MARKER for a line with too little room.
//
// Following the recordings, dragging the next take earlier against a line
// nobody has recorded closes that line's room, down to nothing
// (lib/timeline/line-room). A line with no room has no width, so its usual
// box cannot be drawn — and a line that silently disappears is how its room
// "bit later" before this rule. So a line whose room was made too narrow to
// draw is drawn as a marker instead: always there, at every zoom.
//
// This module says WHICH lines get one and WHERE; the lanes draw it
// (components/timeline/EmptyLineMarker).
//
//   - Only a line whose room was MADE smaller than its natural length. A line
//     at its natural length that merely looks narrow because the timeline is
//     zoomed far out gets none — there would be one on every unrecorded line,
//     and nothing a drag could give it.
//   - Only while the room is narrower than the marker's own tab; wider, its
//     usual box fits and is drawn as always.
//   - Never a line the person has hidden.

import type { CellData } from "@/hooks/useCells"
import { isHiddenCell } from "@/lib/cells/hidden"
import type { Programme } from "./programme"

/** The marker's tab: wide enough to point at. A room narrower than this is
 *  drawn as the marker; one at least this wide as its usual box. */
export const LINE_MARKER_TAB_PX = 12

export interface EmptyLineMarkerSpec {
  cell: CellData
  /** Where the line sits, in px from the lane's start: the seam between its
   *  neighbours for a line with no room, the middle of its room otherwise. */
  atPx: number
  /** The left edge of its tab. Centred on `atPx`, unless another marker's tab
   *  is already there: then beside it, in the lines' order. */
  tabLeftPx: number
  /** How much room the line has, in seconds (0: none). */
  roomSec: number
  /** The line's place among the timeline's lines, from 1. */
  position: number
}

export function emptyLineMarkers(args: {
  /** The lines to consider, e.g. a track's lines with no take on it. */
  cells: readonly CellData[]
  programme: Programme | null | undefined
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
}): EmptyLineMarkerSpec[] {
  const { cells, programme, pxPerSec, viewStartSec, viewEndSec } = args
  if (!programme || cells.length === 0) return []
  const padSec = LINE_MARKER_TAB_PX / pxPerSec
  let positions: Map<string, number> | null = null
  const out: EmptyLineMarkerSpec[] = []
  for (const cell of cells) {
    const slot = programme.byCellId.get(cell.id)
    // `naturalLenSec` is only on an unrecorded line whose room was made smaller.
    if (!slot || slot.naturalLenSec == null || isHiddenCell(cell)) continue
    if (slot.slotLenSec * pxPerSec >= LINE_MARKER_TAB_PX) continue
    const endSec = slot.startSec + slot.slotLenSec
    if (endSec + padSec < viewStartSec || slot.startSec - padSec > viewEndSec) continue
    positions ??= new Map(programme.slots.map((s, i) => [s.cellId, i + 1]))
    const atPx = (slot.startSec + slot.slotLenSec / 2) * pxPerSec
    out.push({ cell, atPx, tabLeftPx: atPx - LINE_MARKER_TAB_PX / 2, roomSec: slot.slotLenSec, position: positions.get(cell.id) ?? 0 })
  }
  // Tabs that would land on each other sit side by side, in the lines' order —
  // and none hangs off the start of the timeline, where it could not be seen.
  out.sort((a, b) => a.position - b.position)
  let taken = 0
  for (const m of out) {
    m.tabLeftPx = Math.max(m.tabLeftPx, taken)
    taken = m.tabLeftPx + LINE_MARKER_TAB_PX
  }
  return out
}
