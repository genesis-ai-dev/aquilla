import type { CellData } from "@/hooks/useCells"
import { deriveParagraphs } from "./parsers/paragraphs"
import { importDisplayLabel, verseLabelFromCanonical } from "./scripture-reference"
import { isStructuralCell } from "./cells/structural"
import { splitFromCellId } from "./timeline/user-line-origin"

type StructuralCell = Pick<CellData, "fileId" | "type" | "metadata" | "paragraphStart" | "status">
  & Partial<Pick<CellData, "group" | "globalReferences">>
interface Entry {
  version: number
  numbered: boolean
  fileId: string
  paragraphStart: boolean
  validated: boolean
  /** The verse number this row carries ("5"), when it carries one. */
  verse: string | null
  /** AQU-1759: the row this one was split off at a quotation mark. */
  splitFrom: string | null
}

/** "a", "b", … "z", then "aa", "ab" — the letters of a partial verse. */
function partLetter(index: number): string {
  let n = index
  let out = ""
  do {
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * AQU-1759: "5a", "5b", "5c" for a verse split at its quotation marks.
 *
 * The pieces split off a verse carry no verse reference of their own — that is
 * what lets the exporters put the verse back together — so on their own they
 * would show no number at all. A run of rows made by splitting one verse is
 * labelled with the verse and a letter each, the way partial verses are cited.
 * A run is the verse row followed by rows whose `splitFrom` points back into
 * the run; anything else ends it.
 */
function versePartsFor(ids: readonly string[], entries: ReadonlyMap<string, Entry>): Map<string, string> {
  const parts = new Map<string, string>()
  let verse: string | null = null
  let members: string[] = []
  const close = () => {
    if (verse && members.length > 1) members.forEach((id, i) => parts.set(id, `${verse}${partLetter(i)}`))
  }
  for (const id of ids) {
    const entry = entries.get(id)
    if (!entry) continue
    if (verse && entry.splitFrom && members.includes(entry.splitFrom)) {
      members.push(id)
      continue
    }
    close()
    verse = entry.verse
    members = [id]
  }
  close()
  return parts
}

interface Group { size: number; draftableCount: number; memberIds: string[] }

/** One instance per store. Save metadata/text changes preserve the published
 * maps; structural changes and validation still update them synchronously. */
export function createEditorStructureCache() {
  const entries = new Map<string, Entry>()
  let order: string[] = []
  let sequential = new Map<string, number>()
  let paragraphs = new Map<string, Group>()
  let verseParts = new Map<string, string>()
  return {
    read(ids: readonly string[], readers: {
      getCellVersion(id: string): number
      getCellView(id: string): StructuralCell | null
    }) {
      let orderChanged = order.length !== ids.length
      let numberingChanged = false
      let paragraphsChanged = false
      let partsChanged = false
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        if (order[i] !== id) orderChanged = true
        const version = readers.getCellVersion(id)
        const before = entries.get(id)
        if (before?.version === version) continue
        const view = readers.getCellView(id)
        if (!view) {
          if (entries.delete(id)) numberingChanged = paragraphsChanged = partsChanged = true
          continue
        }
        const next: Entry = {
          version,
          numbered: !isStructuralCell(view.type) && importDisplayLabel(view.metadata) !== null,
          fileId: view.fileId,
          paragraphStart: view.paragraphStart === true,
          validated: view.status === "validated",
          verse: verseLabelFromCanonical(view.group) ?? verseLabelFromCanonical(view.globalReferences?.[0]),
          splitFrom: splitFromCellId(view),
        }
        if (!before || before.numbered !== next.numbered) numberingChanged = true
        if (!before || before.verse !== next.verse || before.splitFrom !== next.splitFrom) partsChanged = true
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
      if (orderChanged || partsChanged) verseParts = versePartsFor(ids, entries)
      return {
        sequentialNumberByCellId: sequential,
        paragraphGroupInfoByCellId: paragraphs,
        versePartByCellId: verseParts,
      }
    },
  }
}
