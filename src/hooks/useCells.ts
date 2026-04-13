import { useEffect, useState } from "react"
import * as Y from "yjs"

export interface CellData {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  type: string
}

export function useCells(doc: Y.Doc | null): CellData[] {
  const [cells, setCells] = useState<CellData[]>([])

  useEffect(() => {
    if (!doc) {
      setCells([])
      return
    }

    const cellsMap = doc.getMap("cells")
    const orderArray = doc.getArray<string>("order")

    function update() {
      const ordered: CellData[] = []
      const ids = orderArray.toArray()
      for (const id of ids) {
        const cell = cellsMap.get(id) as Y.Map<string> | undefined
        if (!cell) continue
        ordered.push({
          id: cell.get("id") as string,
          original: cell.get("original") as string,
          originalHtml: cell.get("originalHtml") as string | undefined,
          translated: cell.get("translated") as string,
          context: cell.get("context") as string,
          group: cell.get("group") as string,
          type: cell.get("type") as string,
        })
      }
      setCells(ordered)
    }

    update()
    cellsMap.observeDeep(update)
    orderArray.observe(update)

    return () => {
      cellsMap.unobserveDeep(update)
      orderArray.unobserve(update)
    }
  }, [doc])

  return cells
}
