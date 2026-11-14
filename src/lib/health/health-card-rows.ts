// AQU-2278: what the status bar's health card ranks into "Biggest drags", and
// what it calls the lines it shows.

import type { CellStore } from "@/hooks/useActiveCellStore"
import { lineName, readLineNumbering, type LineNameWords } from "@/lib/cells/line-name"
import { createEditorStructureCache } from "@/lib/editor-structure-cache"
import { isExcludedFromWork, type ExcludedCellInput } from "@/lib/health/excluded-cell"
import type { OrderedBy } from "@/lib/parsers/types"

/**
 * The lines that are work, with their health: a parked line never is, and a
 * heading is only when the project counts headings, the same two rules the
 * footer's number beside the card counts by.
 */
export function healthCardRows(
  cells: ReadonlyArray<ExcludedCellInput & { id: string }>,
  healthByCell: ReadonlyMap<string, number>,
  countStructural: boolean,
): Array<{ cellId: string; health: number }> {
  const rows: Array<{ cellId: string; health: number }> = []
  for (const cell of cells) {
    if (isExcludedFromWork(cell, countStructural)) continue
    rows.push({ cellId: cell.id, health: healthByCell.get(cell.id) ?? 0 })
  }
  return rows
}

type NamerStore = Pick<
  CellStore,
  "getCellIdsForLens" | "getListVersion" | "getCellVersion" | "getCellView" | "getNavigationIndex"
>

/**
 * Names the card's drags by the app's one rule for a line (`lineName`), read
 * over the table's own row order. The order is kept until the list changes,
 * so a time-ordered file is not re-sorted each time the card opens.
 */
export function createHealthCardNamer(store: NamerStore) {
  const structure = createEditorStructureCache()
  let order: { listVersion: number; orderedBy: OrderedBy | undefined; ids: readonly string[] } | null = null
  return (cellIds: readonly string[], orderedBy: OrderedBy | undefined, words: LineNameWords): string[] => {
    const listVersion = store.getListVersion()
    if (!order || order.listVersion !== listVersion || order.orderedBy !== orderedBy) {
      order = { listVersion, orderedBy, ids: store.getCellIdsForLens(orderedBy) }
    }
    const numbering = readLineNumbering(store, order.ids, structure)
    return cellIds.map((id) => {
      const cell = store.getCellView(id)
      return cell ? lineName(cell, numbering, words) : words.empty
    })
  }
}
