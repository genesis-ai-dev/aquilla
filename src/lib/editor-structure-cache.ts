import type { CellData } from "@/hooks/useCells"
import { deriveParagraphs } from "./parsers/paragraphs"
import { importDisplayLabel } from "./scripture-reference"

type StructuralCell = Pick<CellData, "fileId" | "type" | "metadata" | "paragraphStart" | "status">
interface Entry {
  version: number
  numbered: boolean
  fileId: string
  paragraphStart: boolean
  validated: boolean
}
interface Group { size: number; draftableCount: number; memberIds: string[] }

/** One instance per store. Save metadata/text changes preserve the published
 * maps; structural changes and validation still update them synchronously. */
export function createEditorStructureCache() {
  const entries = new Map<string, Entry>()
  let order: string[] = []
  let sequential = new Map<string, number>()
  let paragraphs = new Map<string, Group>()
  return {
    read(ids: readonly string[], readers: {
      getCellVersion(id: string): number
      getCellView(id: string): StructuralCell | null
    }) {
      let orderChanged = order.length !== ids.length
      let numberingChanged = false
      let paragraphsChanged = false
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        if (order[i] !== id) orderChanged = true
        const version = readers.getCellVersion(id)
        const before = entries.get(id)
        if (before?.version === version) continue
        const view = readers.getCellView(id)
        if (!view) {
          if (entries.delete(id)) numberingChanged = paragraphsChanged = true
          continue
        }
        const next: Entry = {
          version,
          numbered: view.type !== "paratext" && view.type !== "heading" && importDisplayLabel(view.metadata) !== null,
          fileId: view.fileId,
          paragraphStart: view.paragraphStart === true,
          validated: view.status === "validated",
        }
        if (!before || before.numbered !== next.numbered) numberingChanged = true
        if (!before || before.fileId !== next.fileId || before.paragraphStart !== next.paragraphStart
          || before.validated !== next.validated) paragraphsChanged = true
        entries.set(id, next)
      }
      if (orderChanged) {
        const retained = new Set(ids)
        for (const id of entries.keys()) if (!retained.has(id)) entries.delete(id)
        order = [...ids]
      }
      if (orderChanged || numberingChanged) {
        sequential = new Map()
        let ordinal = 0
        for (const id of ids) if (entries.get(id)?.numbered) sequential.set(id, ++ordinal)
      }
      if (orderChanged || paragraphsChanged) {
        const cells = []
        for (const id of ids) {
          const entry = entries.get(id)
          if (entry) cells.push({ id, fileId: entry.fileId, paragraphStart: entry.paragraphStart })
        }
        paragraphs = new Map()
        for (const group of deriveParagraphs(cells)) {
          if (group.length <= 1) continue
          let draftableCount = 0
          for (const id of group) if (!entries.get(id)?.validated) draftableCount++
          paragraphs.set(group[0], { size: group.length, draftableCount, memberIds: group })
        }
      }
      return { sequentialNumberByCellId: sequential, paragraphGroupInfoByCellId: paragraphs }
    },
  }
}
