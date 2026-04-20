import { useEffect, useState } from "react"
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
  cellLabel?: string
  original: string
  originalHtml?: string
  translated: string
  translatedXml?: Y.XmlFragment
  context: string
  group: string
  /** Optional section label for navigation/progress. USFM/ebible set this to "BOOK CHAPTER" (e.g. "GEN 1"). When present, takes precedence over `group` for sectioning UI. */
  section?: string
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

export function useCells(doc: Y.Doc | null, username = "local", requiredValidations = 1): CellData[] {
  const [cells, setCells] = useState<CellData[]>([])

  useEffect(() => {
    if (!doc) { setCells([]); return }

    const cellsMap = doc.getMap("cells")
    const orderArray = doc.getArray<string>("order")

    function computeOrdered(): CellData[] {
      const ordered: CellData[] = []
      for (const id of orderArray.toArray()) {
        const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
        if (!cell) continue
        const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
        const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
        const historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
        const history: CellHistoryEntry[] = historyArr ? historyArr.toArray() : []
        const threads = extractThreadsFromCell(cell)
        const source = cell.get("__source") as
          | { metadata?: { attachments?: Record<string, CodexCellAttachment>; selectedAudioId?: string; cellLabel?: string } }
          | undefined
        const cellLabel = source?.metadata?.cellLabel
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
        ordered.push({
          id: cell.get("id") as string,
          original: cell.get("original") as string,
          originalHtml: cell.get("originalHtml") as string | undefined,
          translated,
          ...(frag ? { translatedXml: frag } : {}),
          context: cell.get("context") as string,
          group: cell.get("group") as string,
          section: cell.get("section") as string | undefined,
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
        })
      }
      return ordered
    }

    // Initial read is safe inside useEffect — runs after the current render.
    setCells(computeOrdered())

    // Yjs observer callbacks can fire synchronously during another component's
    // render (e.g. TipTap binding initialization triggers a Y op). Defer the
    // setState via queueMicrotask so React doesn't warn about updating a
    // different component mid-render.
    function scheduleUpdate() {
      queueMicrotask(() => { setCells(computeOrdered()) })
    }

    cellsMap.observeDeep(scheduleUpdate)
    orderArray.observe(scheduleUpdate)
    return () => {
      cellsMap.unobserveDeep(scheduleUpdate)
      orderArray.unobserve(scheduleUpdate)
    }
  }, [doc, username, requiredValidations])

  return cells
}
