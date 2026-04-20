import * as Y from "yjs"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { getPlainText, setPlainText } from "@/lib/richtext/translated-xml"
import { toggleCellValidation as toggleCellEditsValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"

export function appendCellHistory(
  doc: Y.Doc,
  cellId: string,
  entry: Omit<CellHistoryEntry, "timestamp">
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
    if (frag) {
      setPlainText(frag, entry.value)
    } else {
      // legacy fallback
      cell.set("translated", entry.value)
    }
    let historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
    if (!historyArr) {
      historyArr = new Y.Array<CellHistoryEntry>()
      cell.set("history", historyArr)
    }
    historyArr.push([{ ...entry, timestamp: new Date().toISOString() }])
  })
}

// Append a history entry WITHOUT modifying the fragment. Use this when the
// fragment was already updated by the TipTap editor — we just want to record
// the revision for audit without clobbering inline formatting via setPlainText.
export function recordHistoryEntry(
  doc: Y.Doc,
  cellId: string,
  entry: Omit<CellHistoryEntry, "timestamp">
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    let historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
    if (!historyArr) {
      historyArr = new Y.Array<CellHistoryEntry>()
      cell.set("history", historyArr)
    }
    historyArr.push([{ ...entry, timestamp: new Date().toISOString() }])
  })
}

export function validateCell(doc: Y.Doc, cellId: string, username: string): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
  if (!translated.trim()) return
  // Commits to the session log AND auto-validates the current user.
  commitCellEdit(doc, cellId, username, ["value"], translated, "human")
  // Keep the keystroke log entry for TipTap/audit.
  appendCellHistory(doc, cellId, { value: translated, source: "human", author: username, validated: true })
}

/**
 * Explicit validation toggle (not tied to a content commit). Delegates to
 * the Yjs-native cell.edits implementation; no more __source mutation.
 */
export function toggleCellValidation(
  doc: Y.Doc, cellId: string, username: string, validate: boolean,
): void {
  toggleCellEditsValidation(doc, cellId, username, validate)
}

export function setCellBacktranslation(
  doc: Y.Doc,
  cellId: string,
  backtranslation: string,
  forText: string
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    cell.set("backtranslation", backtranslation)
    cell.set("backtranslationUpdatedAt", new Date().toISOString())
    cell.set("backtranslationForText", forText)
  })
}
