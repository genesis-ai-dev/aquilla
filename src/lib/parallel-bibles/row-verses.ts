// Which verses an editor row stands for, for the Bible columns beside it.
//
// - A verse row ("JHN 3:16") is that verse; a range row ("GEN 1:1-3") is
//   those verses, joined.
// - A verse split at its quotation marks (AQU-1759) shows the whole verse
//   once, on its first part ("5a"); the later parts ("5b", "5c") say they
//   continue it rather than repeating it.
// - Headings, front matter and rows with no chapter:verse show nothing.
//
// Pure.

export type RowScripture =
  | { kind: "verses"; book: string; chapter: number; from: number; to: number }
  | { kind: "continued" }

export interface RowCellLike {
  type?: string | null
  group?: string | null
  globalReferences?: readonly string[] | null
}

const REF = /^([0-9A-Z]{3})\s+(\d+):(\d+)(?:-(\d+))?$/

/** A range longer than this is not a row a translator reads beside one cell. */
const MAX_RANGE = 40

export function parseVerseRef(ref: string | null | undefined): Extract<RowScripture, { kind: "verses" }> | null {
  const m = REF.exec((ref ?? "").trim().toUpperCase())
  if (!m) return null
  const from = Number(m[3])
  const to = m[4] ? Number(m[4]) : from
  if (to < from || to - from > MAX_RANGE) return null
  return { kind: "verses", book: m[1], chapter: Number(m[2]), from, to }
}

export function rowScripture(cell: RowCellLike, versePart?: string): RowScripture | null {
  if (cell.type === "heading" || cell.type === "paratext") return null
  const letters = versePart ? /[a-z]+$/.exec(versePart)?.[0] : undefined
  if (letters && letters !== "a") return { kind: "continued" }
  return parseVerseRef(cell.group) ?? parseVerseRef(cell.globalReferences?.[0])
}
