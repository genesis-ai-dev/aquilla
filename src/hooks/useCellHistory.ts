import * as Y from "yjs"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { getPlainText, setPlainText } from "@/lib/richtext/translated-xml"

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
  appendCellHistory(doc, cellId, { value: translated, source: "human", author: username, validated: true })
  // Also update __source so the validation is visible in the UI immediately
  // (useCells reads validatedBy from __source.metadata.edits).
  updateSourceValidation(cell, username, true)
}

/**
 * Toggle a user's validation on the latest value-edit in __source. This gives
 * the UI an immediate read path without waiting for serialize→sync→rehydrate.
 * Matches the codex-editor reference: soft-delete model on ValidationEntry[].
 */
export function toggleCellValidation(
  doc: Y.Doc, cellId: string, username: string, validate: boolean,
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  if (validate) {
    // Also append a history entry so the serializer captures it
    const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
    const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
    if (!translated.trim()) return
    appendCellHistory(doc, cellId, { value: translated, source: "human", author: username, validated: true })
  }

  doc.transact(() => {
    updateSourceValidation(cell, username, validate)
  })
}

function updateSourceValidation(cell: Y.Map<unknown>, username: string, validate: boolean): void {
  const source = cell.get("__source") as
    | { metadata?: { edits?: Array<{ editMap?: string[]; validatedBy?: Array<{ username: string; creationTimestamp: number; updatedTimestamp: number; isDeleted: boolean }> }> } }
    | undefined
  if (!source?.metadata?.edits?.length) return

  // Find the latest value-edit (editMap[0] === "value")
  let lastValueEdit: typeof source.metadata.edits[number] | undefined
  for (let i = source.metadata.edits.length - 1; i >= 0; i--) {
    if (source.metadata.edits[i].editMap?.[0] === "value") {
      lastValueEdit = source.metadata.edits[i]
      break
    }
  }
  if (!lastValueEdit) return

  if (!lastValueEdit.validatedBy) lastValueEdit.validatedBy = []
  const now = Date.now()
  const existing = lastValueEdit.validatedBy.findIndex(v => v.username === username)

  if (validate) {
    if (existing === -1) {
      lastValueEdit.validatedBy.push({
        username,
        creationTimestamp: now,
        updatedTimestamp: now,
        isDeleted: false,
      })
    } else {
      lastValueEdit.validatedBy[existing].updatedTimestamp = now
      lastValueEdit.validatedBy[existing].isDeleted = false
    }
  } else {
    if (existing !== -1) {
      lastValueEdit.validatedBy[existing].updatedTimestamp = now
      lastValueEdit.validatedBy[existing].isDeleted = true
    }
  }

  // Write back — triggers Y.Map observers so useCells picks it up.
  cell.set("__source", source)
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
