import * as Y from "yjs"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { getPlainText, setPlainText } from "@/lib/richtext/translated-xml"
import { toggleCellValidation as toggleCellEditsValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"

// Cap on per-cell `history` Y.Array length. Each entry duplicates the full
// `value` text plus author/timestamp metadata, so unbounded growth is the
// main reason a 15+ MB Y.Doc can hit the Cloudflare DO 128 MiB memory cap
// at runtime. The HistoryDrawer UI shows the most recent entries; older
// entries are mostly invisible. Mirror of HISTORY_CAP_PER_CELL in
// sync-worker/src/index.ts (server safety net).
const HISTORY_CAP_PER_CELL = 100

/**
 * Trim the head of a history Y.Array so its length is at most cap. Caller
 * is responsible for wrapping in doc.transact().
 */
function trimHistoryToCap(arr: Y.Array<CellHistoryEntry>, cap: number): void {
  if (arr.length <= cap) return
  arr.delete(0, arr.length - cap)
}

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
    trimHistoryToCap(historyArr, HISTORY_CAP_PER_CELL - 1)
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
    trimHistoryToCap(historyArr, HISTORY_CAP_PER_CELL - 1)
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
 *
 * Imported cells (legacy git projects, fresh .codex notebooks) often arrive
 * with translated content but no `metadata.edits` history — there's nothing
 * for the underlying toggler to attach a validator to, so it would silently
 * no-op and leave the user wondering why "Validate" did nothing. When that
 * happens we seed a value-edit from the current text, which makes the cell
 * a first-class validatable record going forward.
 */
export function toggleCellValidation(
  doc: Y.Doc, cellId: string, username: string, validate: boolean,
): void {
  if (validate) {
    const cellsMap = doc.getMap("cells")
    const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
    if (cell) {
      const arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
      const hasValueEdit = arr ? arrayHasValueEdit(arr) : false
      if (!hasValueEdit) {
        // Seed a value-edit from the current translated text and validate
        // in one shot. validateCell handles the empty-text guard.
        validateCell(doc, cellId, username)
        return
      }
    }
  }
  toggleCellEditsValidation(doc, cellId, username, validate)
}

function arrayHasValueEdit(arr: Y.Array<Y.Map<unknown>>): boolean {
  for (let i = 0; i < arr.length; i++) {
    const entry = arr.get(i)
    const editMapArr = entry.get("editMap") as Y.Array<string> | undefined
    if (editMapArr?.get(0) === "value") return true
  }
  return false
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
