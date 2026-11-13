// The Bible document view (AQU-2559) reads a book as an ordered list of units:
// one per cell. A unit is either a verse (or any other line of text) or one of
// the source's own headings. Everything the two panes and the export preview
// draw is derived from this list.

import type { CellData } from "@/hooks/useCells"
import { splitUsfmTail } from "../../../db/shared/usfm-layout"

export interface DocUnit {
  cellId: string
  /** "heading": a heading or title that is a cell of its own in the source. */
  kind: "verse" | "heading"
  /** The source row's address ("GEN 1:3", "GEN 1:s1:2"); null for added lines. */
  ref: string | null
  /** 0 before the first chapter; null when the unit has no address. */
  chapter: number | null
  /** What the verse-number chip shows ("3", "3-4"); "" for added lines. */
  label: string
  /** The USFM marker of a heading unit ("s1", "mt1"). */
  headingMarker: string | null
  /** Source words, without the paragraph lines that open the next verse. */
  source: string
  sourceParagraphStart: boolean
  sourceParagraphMarker: string | null
  target: string
}

const VERSE_REF = /^\S+\s+(\d+):([^:\s]+)$/
const HEADING_REF = /^\S+(?:\s+(\d+))?:([a-z]+\d*):\d+$/

/** Chapter, label and heading marker of a canonical ref. */
export function parseUnitRef(ref: string | null): { chapter: number | null; label: string; headingMarker: string | null } {
  if (!ref) return { chapter: null, label: "", headingMarker: null }
  const verse = VERSE_REF.exec(ref)
  if (verse) return { chapter: Number(verse[1]), label: verse[2], headingMarker: null }
  const heading = HEADING_REF.exec(ref)
  if (heading) return { chapter: heading[1] ? Number(heading[1]) : 0, label: "", headingMarker: heading[2] }
  return { chapter: null, label: "", headingMarker: null }
}

/** The units of a file, in the store's order. Hidden cells are left out: they
 *  are not part of the book the translator is reading. */
export function unitsFromCells(cells: readonly CellData[]): DocUnit[] {
  const units: DocUnit[] = []
  for (const cell of cells) {
    if (cell.hidden) continue
    const ref = cell.globalReferences?.[0] || null
    const parsed = parseUnitRef(ref)
    const heading = cell.type === "heading" || cell.type === "paratext"
    units.push({
      cellId: cell.id,
      kind: heading ? "heading" : "verse",
      ref,
      chapter: parsed.chapter,
      label: parsed.label || cell.cellLabel || "",
      headingMarker: heading ? parsed.headingMarker ?? "s1" : null,
      source: heading ? cell.original : splitUsfmTail(cell.original).body.trimEnd(),
      sourceParagraphStart: cell.paragraphStart === true,
      sourceParagraphMarker: cell.paragraphMarker ?? null,
      target: cell.translated ?? "",
    })
  }
  return units
}
