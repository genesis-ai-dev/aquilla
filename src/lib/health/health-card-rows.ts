// AQU-2278: the rows the status bar's health card ranks into "Biggest drags".
//
// A line is called what the editor row calls it: its own label when it has
// one, else its reference ("RUT 1:4", a cue's timing, a script's "B4") from
// `namedCellRef`, else its place in the table ("row 3"), the stand-in the row
// itself uses. Never its cell id: nobody can tell which line "01a1…" is.

import { namedCellRef } from "@/lib/cell-named-ref"

export interface HealthCardCell {
  id: string
  cellLabel?: string
  context?: string | null
  globalReferences?: readonly string[] | null
}

export interface HealthCardRow {
  cellId: string
  label: string
  health: number
}

/**
 * `rowOrder` is the table's row order (`getCellIdsForLens`), so a line's
 * number matches the row it opens. `rowName` words that number. A line not in
 * the table (a hidden one) has no row to name, and keeps its id.
 */
export function healthCardRows(
  cells: readonly HealthCardCell[],
  healthByCell: ReadonlyMap<string, number>,
  rowOrder: readonly string[],
  rowName: (index: number) => string,
): HealthCardRow[] {
  let position: Map<string, number> | null = null
  const rowLabel = (id: string): string => {
    position ??= new Map(rowOrder.map((rowId, i) => [rowId, i + 1]))
    const index = position.get(id)
    return index === undefined ? id : rowName(index)
  }
  return cells.map((cell) => ({
    cellId: cell.id,
    label: cell.cellLabel || namedCellRef(cell) || rowLabel(cell.id),
    health: healthByCell.get(cell.id) ?? 0,
  }))
}
