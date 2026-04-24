import * as Y from "yjs"
import type { RuleWaiver } from "@/lib/parsers/types"

/**
 * Waivers are stored as a plain JSON-serialized array in cell.get("waivers").
 * The array is small (≤ rules in the project) and only rewritten on
 * waive/unwaive, so we avoid the complexity of a Y.Array of Y.Maps.
 */
export function readCellWaivers(doc: Y.Doc, cellId: string): RuleWaiver[] {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return []
  const raw = cell.get("waivers") as RuleWaiver[] | undefined
  return Array.isArray(raw) ? raw : []
}

export function setCellWaivers(doc: Y.Doc, cellId: string, waivers: RuleWaiver[]): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return
  doc.transact(() => {
    cell.set("waivers", waivers)
  })
}
