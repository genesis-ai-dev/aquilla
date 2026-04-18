import { useEffect, useState } from "react"
import * as Y from "yjs"
import type { CellHistoryEntry, SourceLocation, CommentThread } from "@/lib/parsers/types"
import type { CodexCellAttachment, ValidationEntry } from "@/lib/codex-editor/types"
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
  type: string
  status: "empty" | "unvalidated" | "validated"
  validationStatus: ValidationStatus
  activeValidators: string[]
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
  edits: Array<{ editMap?: string[]; validatedBy?: ValidationEntry[] }> | undefined,
  currentUsername: string,
  requiredValidations: number,
): { validationStatus: ValidationStatus; activeValidators: string[] } {
  if (!translated || !translated.trim()) {
    return { validationStatus: "empty", activeValidators: [] }
  }

  let validatedBy: ValidationEntry[] = []
  if (edits) {
    for (let i = edits.length - 1; i >= 0; i--) {
      if (edits[i].editMap?.[0] === "value") {
        validatedBy = edits[i].validatedBy ?? []
        break
      }
    }
  }

  const active = validatedBy.filter(v =>
    v && typeof v === "object" && typeof v.username === "string" && !v.isDeleted
  )
  const activeUsernames = active.map(v => v.username)
  const count = activeUsernames.length

  if (count === 0) return { validationStatus: "none", activeValidators: [] }
  if (count >= requiredValidations) return { validationStatus: "full", activeValidators: activeUsernames }
  if (activeUsernames.includes(currentUsername)) return { validationStatus: "self", activeValidators: activeUsernames }
  return { validationStatus: "others", activeValidators: activeUsernames }
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
          | { metadata?: { attachments?: Record<string, CodexCellAttachment>; selectedAudioId?: string; cellLabel?: string; edits?: Array<{ editMap?: string[]; validatedBy?: ValidationEntry[] }> } }
          | undefined
        const cellLabel = source?.metadata?.cellLabel
        const { validationStatus, activeValidators } = deriveValidationStatus(
          translated, source?.metadata?.edits, username, requiredValidations,
        )
        ordered.push({
          id: cell.get("id") as string,
          original: cell.get("original") as string,
          originalHtml: cell.get("originalHtml") as string | undefined,
          translated,
          ...(frag ? { translatedXml: frag } : {}),
          context: cell.get("context") as string,
          group: cell.get("group") as string,
          type: cell.get("type") as string,
          status: deriveStatus(translated, history),
          validationStatus,
          activeValidators,
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
