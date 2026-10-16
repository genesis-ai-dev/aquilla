/**
 * The footnote tray's feed (FootnotesTray): one entry per visible row that
 * has footnotes. Shared by the built-in table and the extension editor (whose
 * frame reports its visible rows over the bridge, `editor.visible`).
 */

import type { CellData } from "@/hooks/useCells"
import type { CellStore } from "@/hooks/useActiveCellStore"
import { looksLikeUuid } from "@/lib/uuid"
import type { VisibleFootnoteEntry } from "./types"

export function humanFootnoteCellRef(cell: Pick<CellData, "group" | "context">): string {
  const value = (cell.group || cell.context || "").trim()
  if (!value || looksLikeUuid(value)) return ""
  return value
}

/** Tray entries for these visible rows, in order. `rowIndexOf` gives the
 *  row's display index (its fallback label). */
export function visibleFootnoteEntriesFor(
  store: CellStore,
  cellIds: readonly string[],
  rowIndexOf: (cellId: string) => number,
  hovered: { cellId: string; index: number } | null = null,
): VisibleFootnoteEntry[] {
  const out: VisibleFootnoteEntry[] = []
  for (const cellId of cellIds) {
    const cell = store.getCellView(cellId)
    if (!cell) continue
    const footnotes = store.getCellFootnotes(cell.id)
    if (!footnotes.hasFootnotes) continue
    const index = rowIndexOf(cell.id)
    out.push({
      cellId: cell.id,
      cellLabel: cell.cellLabel || String(index + 1),
      cellRef: humanFootnoteCellRef(cell),
      rowIndex: index,
      sourceFootnotes: footnotes.sourceFootnotes,
      targetFootnotes: footnotes.targetFootnotes,
      activeFootnoteIndex: hovered?.cellId === cell.id ? hovered.index : null,
      isDocx: (cell.fileId ?? "").endsWith(".docx"),
      numberOffset: store.getFootnoteOffsets(cell.id).target,
    })
  }
  return out
}
