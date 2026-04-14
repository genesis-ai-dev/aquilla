import { useEffect, useState } from "react"
import * as Y from "yjs"
import type { CellHistoryEntry, SourceLocation } from "@/lib/parsers/types"

export interface CellData {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  type: string
  status: "empty" | "unvalidated" | "validated"
  history: CellHistoryEntry[]
  sourceLocation?: SourceLocation
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
}

function deriveStatus(translated: string, history: CellHistoryEntry[]): "empty" | "unvalidated" | "validated" {
  if (!translated || !translated.trim()) return "empty"
  if (history.length === 0) return "validated"
  return history[history.length - 1].validated ? "validated" : "unvalidated"
}

export function useCells(doc: Y.Doc | null): CellData[] {
  const [cells, setCells] = useState<CellData[]>([])

  useEffect(() => {
    if (!doc) { setCells([]); return }

    const cellsMap = doc.getMap("cells")
    const orderArray = doc.getArray<string>("order")

    function update() {
      const ordered: CellData[] = []
      for (const id of orderArray.toArray()) {
        const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
        if (!cell) continue
        const translated = (cell.get("translated") as string) || ""
        const historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
        const history: CellHistoryEntry[] = historyArr ? historyArr.toArray() : []
        ordered.push({
          id: cell.get("id") as string,
          original: cell.get("original") as string,
          originalHtml: cell.get("originalHtml") as string | undefined,
          translated,
          context: cell.get("context") as string,
          group: cell.get("group") as string,
          type: cell.get("type") as string,
          status: deriveStatus(translated, history),
          history,
          sourceLocation: cell.get("sourceLocation") as SourceLocation | undefined,
          backtranslation: cell.get("backtranslation") as string | undefined,
          backtranslationUpdatedAt: cell.get("backtranslationUpdatedAt") as string | undefined,
          backtranslationForText: cell.get("backtranslationForText") as string | undefined,
        })
      }
      setCells(ordered)
    }

    update()
    cellsMap.observeDeep(update)
    orderArray.observe(update)
    return () => { cellsMap.unobserveDeep(update); orderArray.unobserve(update) }
  }, [doc])

  return cells
}
