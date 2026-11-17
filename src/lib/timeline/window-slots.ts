// Which lines a mounted timeline column actually has to look at.
//
// A book lays every line into the programme, and that list is the scroll
// length. A column is one slice of it. Walking every line to decide that
// almost none of them are in the slice is what stalls the audio row as each
// column mounts. The programme's slots are already in time order, so the
// column asks for the handful that meet its window.

export interface WindowSlot {
  cellId: string
  startSec: number
  slotLenSec: number
}

/** Indexes of slots that meet [viewStart, viewEnd], plus one past each edge
 *  so a neighbour still constrains the chip at the rim of the column. */
export function slotWindow(
  slots: readonly WindowSlot[],
  viewStart: number,
  viewEnd: number,
): { from: number; to: number } {
  const n = slots.length
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const slot = slots[mid]
    if (slot.startSec + slot.slotLenSec < viewStart) lo = mid + 1
    else hi = mid
  }
  const from = Math.max(0, lo - 1)
  lo = from
  hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (slots[mid].startSec <= viewEnd) lo = mid + 1
    else hi = mid
  }
  return { from, to: Math.min(n, lo + 1) }
}

interface Prepared<T> {
  byId: Map<string, T>
  extrasBySlots: WeakMap<object, readonly T[]>
}

const preparedByCells = new WeakMap<object, Prepared<unknown>>()

/**
 * The cells whose programme slot meets the window, in slot order, plus any
 * cell the programme does not place (it still uses its own times).
 *
 * A short list is returned as it arrived. The first call for a cell list
 * indexes it; later columns of the same list only look up the window.
 */
export function cellsInSlotWindow<T extends { id: string }>(
  cells: readonly T[],
  slots: readonly WindowSlot[],
  viewStart: number,
  viewEnd: number,
): readonly T[] {
  if (slots.length === 0 || cells.length < 64) return cells
  // The column's cells are the programme's lines, in the same order. The
  // window is a slice of that list; nothing is indexed.
  if (
    cells.length === slots.length &&
    cells[0]?.id === slots[0]?.cellId &&
    cells[cells.length - 1]?.id === slots[slots.length - 1]?.cellId
  ) {
    const { from, to } = slotWindow(slots, viewStart, viewEnd)
    return cells.slice(from, to)
  }
  let prepared = preparedByCells.get(cells) as Prepared<T> | undefined
  if (!prepared) {
    const byId = new Map<string, T>()
    for (const cell of cells) byId.set(cell.id, cell)
    prepared = { byId, extrasBySlots: new WeakMap() }
    preparedByCells.set(cells, prepared)
  }
  let extras = prepared.extrasBySlots.get(slots)
  if (!extras) {
    const placed = new Set<string>()
    for (const slot of slots) placed.add(slot.cellId)
    const found: T[] = []
    for (const cell of cells) if (!placed.has(cell.id)) found.push(cell)
    extras = found
    prepared.extrasBySlots.set(slots, extras)
  }
  const { from, to } = slotWindow(slots, viewStart, viewEnd)
  const out: T[] = []
  for (let i = from; i < to; i++) {
    const cell = prepared.byId.get(slots[i].cellId)
    if (cell) out.push(cell)
  }
  for (const cell of extras) out.push(cell)
  return out
}
