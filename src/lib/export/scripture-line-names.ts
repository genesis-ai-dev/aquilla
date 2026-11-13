// AQU-2560: naming a line of scripture by where it sits in the book.
//
// Split out of `audio-per-line.ts`, which is the only caller today: the by-line
// audio export names a Bible file's takes with these instead of by character.

import type { CellData } from "@/hooks/useCells"
import { isStructuralCell } from "@/lib/cells/structural"
import { canonicalOf } from "./audio-chapter"
import { characterKey } from "./audio-by-character"

/**
 * AQU-2560: where a line sits in a book of scripture.
 *
 * A Bible file has no cast, so the character segment of the classic name says
 * nothing about a line — and on a project migrated from Codex it says something
 * false: the migration read each cell's `cellLabel` (the verse number) as a
 * speaker, so the "character" is a voice called `1`, `2`, … with no chapter.
 * The reference the cell carries is what names it.
 */
export interface ScriptureLine {
  book: string
  chapter: string
  /** `54`, a range `13-14`, or `0` for a line above the book's first verse. */
  verse: string
  /**
   * Set on a line with no verse of its own, which is named after the verse it
   * sits under: `heading` for a title or section head, `added` for a line
   * someone inserted in the app. Absent on the verse's own line.
   */
  follows?: "heading" | "added"
}

/**
 * Each line's place in the book, by cell id — or null when the file is not
 * scripture, which is decided the way the chapter export and the progress
 * rollup decide it: at least one cell carries a `BOOK chapter:verse` reference.
 *
 * Walked in the order the lines are heard (`collectPerLineClips`'s order), so
 * "the verse above" means the same line in both.
 */
export function scriptureLines(cells: readonly CellData[]): Map<string, ScriptureLine> | null {
  const ordered = [...cells].sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity))
  const own = ordered.map(canonicalOf)
  const first = own.find((ref) => ref != null)
  if (!first) return null
  const out = new Map<string, ScriptureLine>()
  let above: ScriptureLine | null = null
  ordered.forEach((cell, i) => {
    const ref = own[i]
    const structural = isStructuralCell(cell.type)
    if (ref && !structural) {
      above = { book: ref.book, chapter: ref.chapter, verse: ref.verse }
      out.set(cell.id, above)
      return
    }
    // A heading is named `…_heading` even when it carries a reference, or it
    // would take the name of the verse it introduces. Above the first verse
    // there is nothing to sit under, so the line takes that verse's chapter
    // and verse 0, which sorts it in front.
    const at: ScriptureLine = ref ?? above ?? { book: first.book, chapter: first.chapter, verse: "0" }
    out.set(cell.id, { book: at.book, chapter: at.chapter, verse: at.verse, follows: structural ? "heading" : "added" })
  })
  return out
}

/** Padded to three digits, so `LUK_001_009` sorts before `LUK_001_010`. */
const pad3 = (n: string) => n.padStart(3, "0")

/** `LUK_001_054`, `LUK_001_013-014`, `LUK_001_004_heading`. */
export function scriptureSegment(at: ScriptureLine): string {
  const verse = at.verse.split("-").map(pad3).join("-")
  return `${characterKey(at.book)}_${pad3(at.chapter)}_${verse}${at.follows ? `_${at.follows}` : ""}`
}

/** `LUK 1:54`, `LUK 1:4 heading` — a scripture line the way a person says it. */
export function scriptureLabel(at: ScriptureLine): string {
  return `${at.book} ${at.chapter}:${at.verse}${at.follows ? ` ${at.follows}` : ""}`
}
