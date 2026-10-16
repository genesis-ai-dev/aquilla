// Readable place for one Find & Replace hit.
//
// A reviewer choosing what to replace needs "Genesis 1:1", not the file and
// cell ids. Scripture cells use the book, chapter, and verse. Everything else
// uses the cell's own label or section, and otherwise the file name plus its
// position in the file. A raw id is never a place name.
//
// Two cells that share a place (a verse split across rows) are numbered in
// file order: "Genesis 1:1 (1 of 2)", "Genesis 1:1 (2 of 2)".

import { isStructuralCell } from "@/lib/cells/structural"
import { getBookName } from "@/lib/file-labeling/bible-book-names"
import { parseCanonicalRef } from "@/lib/progress/canonical-rollup"
import { chapterLabelFromCanonical, parseScriptureReference } from "@/lib/scripture-reference"

export interface MatchLocationInput {
  cellId: string
  fileId: string
  fileName?: string | null
  canonicalRef?: string | null
  cellType?: string | null
  placeLabel?: string | null
  position?: number | null
}

/** The place before the "(2 of 2)" suffix. */
export type MatchPlace =
  | { kind: "text"; text: string }
  | { kind: "filePosition"; fileName: string; position: number }
  | { kind: "line"; position: number }
  | { kind: "unnamed" }

export interface AssignedMatchPlace {
  place: MatchPlace
  /** 1-based among hits that share this place. Omitted when it is the only one. */
  index?: number
  total?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRawId(value: string): boolean {
  return UUID_RE.test(value.trim())
}

/** A stored label a person can read. Bare numbers and ids are not one. */
function readableLabel(value: string | null | undefined): string | null {
  const text = value?.trim() ?? ""
  if (!text || isRawId(text) || /^\d+$/.test(text)) return null
  return text
}

function readableFileName(name: string | null | undefined, fileId: string): string | null {
  const text = name?.trim() ?? ""
  if (!text || text === fileId || isRawId(text)) return null
  return text
}

/** `GEN 1:1` → `Genesis 1:1`. Chapter-only addresses are not a verse. */
function versePlace(value: string | null | undefined): string | null {
  const parsed = parseScriptureReference(value)
  if (parsed?.verse) return `${parsed.bookName} ${parsed.chapter}:${parsed.verse}`
  const loose = parseCanonicalRef(value)
  if (!loose) return null
  const name = getBookName(loose.book) ?? loose.book
  return `${name} ${loose.chapter}:${loose.verse}`
}

/** `GEN 1:1` → `Genesis 1`, for a heading that belongs to a chapter. */
function sectionPlace(value: string | null | undefined): string | null {
  const chapter = chapterLabelFromCanonical(value)
  if (chapter) return chapter
  const loose = parseCanonicalRef(value)
  if (!loose) return null
  const name = getBookName(loose.book) ?? loose.book
  return `${name} ${loose.chapter}`
}

function basePlace(row: MatchLocationInput): MatchPlace {
  if (!isStructuralCell(row.cellType)) {
    const verse = versePlace(row.canonicalRef)
    if (verse) return { kind: "text", text: verse }
  }
  const label = readableLabel(row.placeLabel)
  if (label) return { kind: "text", text: label }
  const section = sectionPlace(row.canonicalRef)
  if (section) return { kind: "text", text: section }
  const fileName = readableFileName(row.fileName, row.fileId)
  const position = row.position != null && row.position > 0 ? row.position : null
  if (fileName && position != null) return { kind: "filePosition", fileName, position }
  if (fileName) return { kind: "text", text: fileName }
  if (position != null) return { kind: "line", position }
  return { kind: "unnamed" }
}

function placeKey(place: MatchPlace): string {
  switch (place.kind) {
    case "text":
      return `t\0${place.text}`
    case "filePosition":
      return `f\0${place.fileName}\0${place.position}`
    case "line":
      return `l\0${place.position}`
    case "unnamed":
      return "u"
  }
}

/**
 * One place per hit, in the same order as `rows`. Hits that share a place
 * are numbered by file position, then cell id, so the second half of a split
 * verse stays "(2 of 2)" even when it ranks first.
 */
export function assignMatchPlaces(rows: readonly MatchLocationInput[]): AssignedMatchPlace[] {
  const places = rows.map(basePlace)
  const groups = new Map<string, number[]>()
  places.forEach((place, index) => {
    const key = placeKey(place)
    const list = groups.get(key)
    if (list) list.push(index)
    else groups.set(key, [index])
  })

  const assigned: AssignedMatchPlace[] = places.map((place) => ({ place }))
  for (const indexes of groups.values()) {
    const cells = new Map<string, { position: number; cellId: string }>()
    for (const index of indexes) {
      const row = rows[index]
      const cellKey = `${row.fileId}\0${row.cellId}`
      if (cells.has(cellKey)) continue
      cells.set(cellKey, {
        position: row.position != null && row.position > 0 ? row.position : Number.POSITIVE_INFINITY,
        cellId: row.cellId,
      })
    }
    if (cells.size < 2) continue
    const order = [...cells.entries()].sort((a, b) =>
      a[1].position - b[1].position || a[1].cellId.localeCompare(b[1].cellId),
    )
    const indexByCell = new Map(order.map(([cellKey], index) => [cellKey, index + 1]))
    for (const index of indexes) {
      const row = rows[index]
      assigned[index] = {
        place: places[index],
        index: indexByCell.get(`${row.fileId}\0${row.cellId}`),
        total: cells.size,
      }
    }
  }
  return assigned
}
