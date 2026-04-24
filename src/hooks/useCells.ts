import { useEffect, useRef, useState } from "react"
import * as Y from "yjs"
import type { CellHistoryEntry, SourceLocation, CommentThread } from "@/lib/parsers/types"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { EditValidationSummary } from "@/lib/codex-editor/edits/types"
import { snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers"
import { extractThreadsFromCell } from "./useComments"
import { getPlainText } from "@/lib/richtext/translated-xml"

export type ValidationStatus = "empty" | "none" | "others" | "self" | "full"

export interface CellData {
  id: string
  fileId: string
  cellLabel?: string
  original: string
  originalHtml?: string
  translated: string
  translatedXml?: Y.XmlFragment
  context: string
  group: string
  /** Optional section label for navigation/progress. USFM/ebible set this to "BOOK CHAPTER" (e.g. "GEN 1"). */
  section?: string
  /**
   * Scripture verse refs (e.g. ["LUK 1:1"]) attached to this cell. Drives sidebar section
   * derivation and future highlighting. Empty/undefined for non-scripture cells.
   */
  globalReferences?: string[]
  type: string
  status: "empty" | "unvalidated" | "validated"
  validationStatus: ValidationStatus
  activeValidators: string[]
  /** Read-only projection of cell.edits (value-editMap entries only, newest-last)
   *  used by the validation popover's history timeline. */
  validationHistory: EditValidationSummary[]
  history: CellHistoryEntry[]
  threads: CommentThread[]
  sourceLocation?: SourceLocation
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
  attachments?: Record<string, CodexCellAttachment>
  selectedAudioId?: string
  /** Cue start/end timestamps (seconds) from the cell's CodexData. Populated
   *  for subtitle-imported cells; used by the recording modal's duration bar. */
  startTime?: number
  endTime?: number
}


function deriveStatus(translated: string, history: CellHistoryEntry[]): "empty" | "unvalidated" | "validated" {
  if (!translated || !translated.trim()) return "empty"
  if (history.length === 0) return "validated"
  return history[history.length - 1].validated ? "validated" : "unvalidated"
}

function deriveValidationStatus(
  translated: string,
  cell: Y.Map<unknown>,
  currentUsername: string,
  requiredValidations: number,
): { validationStatus: ValidationStatus; activeValidators: string[] } {
  if (!translated || !translated.trim()) {
    return { validationStatus: "empty", activeValidators: [] }
  }
  const arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) return { validationStatus: "none", activeValidators: [] }
  // Walk backwards for the latest value-edit.
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr.get(i)
    const editMapArr = entry.get("editMap") as Y.Array<string> | undefined
    if (editMapArr?.get(0) !== "value") continue
    const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
    const active: string[] = []
    if (validators) {
      validators.forEach((v, username) => { if (!v.get("isDeleted")) active.push(username) })
    }
    const count = active.length
    if (count === 0) return { validationStatus: "none", activeValidators: [] }
    // Threshold met → "full" takes precedence over "self" (matches the desktop
    // AudioValidationStatusIcon logic: isFullyValidated wins).
    if (count >= requiredValidations) return { validationStatus: "full", activeValidators: active }
    if (active.includes(currentUsername)) return { validationStatus: "self", activeValidators: active }
    return { validationStatus: "others", activeValidators: active }
  }
  return { validationStatus: "none", activeValidators: [] }
}

function buildCellData(
  cell: Y.Map<unknown>,
  fileId: string,
  username: string,
  requiredValidations: number,
): CellData {
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
  const historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
  const history: CellHistoryEntry[] = historyArr ? historyArr.toArray() : []
  const threads = extractThreadsFromCell(cell)
  const source = cell.get("__source") as
    | { metadata?: {
        attachments?: Record<string, CodexCellAttachment>
        selectedAudioId?: string
        cellLabel?: string
        data?: { startTime?: number; endTime?: number }
      } }
    | undefined
  const cellLabel = source?.metadata?.cellLabel
  const startTime = source?.metadata?.data?.startTime
  const endTime = source?.metadata?.data?.endTime
  const { validationStatus, activeValidators } = deriveValidationStatus(
    translated, cell, username, requiredValidations,
  )
  const editsArr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  const validationHistory: EditValidationSummary[] = []
  if (editsArr) {
    for (let i = 0; i < editsArr.length; i++) {
      const snap = snapshotEntry(editsArr.get(i))
      if (snap.editMap[0] !== "value") continue
      const active = snap.validatedBy.filter(v => !v.isDeleted).map(v => v.username)
      validationHistory.push({
        authors: snap.authors,
        timestamp: snap.timestamp,
        type: snap.type,
        editMap: snap.editMap,
        value: snap.value,
        validatorsActive: active,
        validatorsAll: snap.validatedBy,
      })
    }
  }
  return {
    id: cell.get("id") as string,
    fileId,
    original: cell.get("original") as string,
    originalHtml: cell.get("originalHtml") as string | undefined,
    translated,
    ...(frag ? { translatedXml: frag } : {}),
    context: cell.get("context") as string,
    group: cell.get("group") as string,
    section: cell.get("section") as string | undefined,
    globalReferences: cell.get("globalReferences") as string[] | undefined,
    type: cell.get("type") as string,
    status: deriveStatus(translated, history),
    validationStatus,
    activeValidators,
    validationHistory,
    history,
    threads,
    sourceLocation: cell.get("sourceLocation") as SourceLocation | undefined,
    backtranslation: cell.get("backtranslation") as string | undefined,
    backtranslationUpdatedAt: cell.get("backtranslationUpdatedAt") as string | undefined,
    backtranslationForText: cell.get("backtranslationForText") as string | undefined,
    attachments: source?.metadata?.attachments,
    selectedAudioId: source?.metadata?.selectedAudioId,
    ...(cellLabel ? { cellLabel } : {}),
    ...(typeof startTime === "number" ? { startTime } : {}),
    ...(typeof endTime === "number" ? { endTime } : {}),
  }
}

export function useCells(doc: Y.Doc | null, fileId: string, username = "local", requiredValidations = 1): CellData[] {
  const [cells, setCells] = useState<CellData[]>([])
  // Per-cell cache keyed by cell id. Entries are reused across observer fires
  // when the cell's Yjs content didn't change, so consumers see referentially
  // stable cell objects (lets React.memo skip unaffected rows).
  const cacheRef = useRef<Map<string, CellData>>(new Map())

  useEffect(() => {
    if (!doc) { setCells([]); cacheRef.current.clear(); return }

    const cellsMap = doc.getMap("cells")
    const orderArray = doc.getArray<string>("order")
    const cache = cacheRef.current
    cache.clear()

    function computeOrdered(): CellData[] {
      const ordered: CellData[] = []
      const seen = new Set<string>()
      for (const id of orderArray.toArray()) {
        seen.add(id)
        let entry = cache.get(id)
        if (!entry) {
          const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
          if (!cell) continue
          entry = buildCellData(cell, fileId, username, requiredValidations)
          cache.set(id, entry)
        }
        ordered.push(entry)
      }
      // Drop cache entries for cells no longer in the order.
      for (const id of [...cache.keys()]) {
        if (!seen.has(id)) cache.delete(id)
      }
      return ordered
    }

    // Initial read is safe inside useEffect — runs after the current render.
    setCells(computeOrdered())

    const dirtyIds = new Set<string>()
    let fullRebuild = false
    let scheduled = false

    function flush() {
      scheduled = false
      if (fullRebuild) {
        cache.clear()
        fullRebuild = false
        dirtyIds.clear()
        setCells(computeOrdered())
        return
      }
      if (dirtyIds.size === 0) {
        // No-op (shouldn't happen, but be safe).
        return
      }
      // Invalidate only the cells whose Yjs content reported a change.
      for (const id of dirtyIds) cache.delete(id)
      dirtyIds.clear()
      setCells(computeOrdered())
    }

    function schedule() {
      if (scheduled) return
      scheduled = true
      // Yjs observers can fire synchronously during another component's render
      // (e.g. TipTap binding initialization triggers a Y op). Defer via
      // queueMicrotask so React doesn't warn about updating mid-render.
      queueMicrotask(flush)
    }

    function onCellsChange(events: Y.YEvent<Y.AbstractType<unknown>>[]) {
      for (const ev of events) {
        // observeDeep on cellsMap: the event path is relative to cellsMap. A
        // direct change to cellsMap (key add/remove) has path.length === 0;
        // changes nested inside a cell have path[0] === cellId.
        if (ev.path.length === 0) {
          // Cell add/remove on the top-level map. Could change cell identities;
          // rebuild from scratch to keep cache consistent.
          fullRebuild = true
          break
        }
        const head = ev.path[0]
        if (typeof head === "string") {
          dirtyIds.add(head)
        } else {
          // Unexpected path shape — fall back to full rebuild rather than
          // silently miss an update.
          fullRebuild = true
          break
        }
      }
      schedule()
    }

    function onOrderChange() {
      // Order changes (insert/move/delete) don't affect any cell's content,
      // but the resulting array must reflect the new ordering. We still reuse
      // cached entries — only the array is rebuilt.
      schedule()
    }

    cellsMap.observeDeep(onCellsChange)
    orderArray.observe(onOrderChange)
    return () => {
      cellsMap.unobserveDeep(onCellsChange)
      orderArray.unobserve(onOrderChange)
    }
  }, [doc, fileId, username, requiredValidations])

  return cells
}
