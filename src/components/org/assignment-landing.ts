// AQU-1493: where "Assigned to me" lands for a section assignment.
//
// Sam, 2026-10-03: carol is assigned RUT 2, and clicking her row in the org's
// "Assigned to me" list opened the editor at the top of Ruth. The row only
// knew the FILE. It now opens the editor on a cell of the assignment, through
// the same deep link the board's "Go to first untranslated" uses
// (`editorCellHref` with the flash on): the first cell still to translate, else
// the first still to validate, else the assignment's first cell. A whole-file
// assignment keeps opening the file, as it always has.
//
// A chapter assignment's row carries no cell ids — the server sends its scope
// as a label — so the cells are read on the click, one chapter at a time, from
// the same per-chapter read the board's chapter card draws its chips from. That
// read already places headings and lines added in the editor in their chapter,
// so the landing agrees with the chips a manager sees for the same chapter.
//
// A 'cells' assignment (AQU-1628, the editor's current selection) does carry
// its ids, but only on the per-project inbox read; the org-wide read this list
// uses does not send them, so such a row opens its file like a whole-file one.

import type { MyAssignment } from "@/lib/sync/assignments"
import { getBookOrdinal, isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import { laneCountsAudio, laneCountsText, laneLineDone, type LaneDelivers } from "@/lib/lanes/lane-delivers"
import { shortVerses, type ShortVerse } from "./plan/verse-chips"

/**
 * The section keys a section assignment covers ("RUT 2"), in reading order;
 * empty for anything else, which opens its file as before.
 *
 * Two label shapes reach the inbox for one `chapters` scope: the editor's
 * Assign dialog writes the bare keys ("RUT 2, RUT 3"), and the org's Assign
 * work dialog prefixes the file's name ("Ruth · RUT 2, RUT 3"). An old FRO-192
 * label may also end " in <file>". A part that is not a real key reads as an
 * empty chapter and is skipped, so a label this cannot parse still opens the
 * file rather than nowhere.
 */
export function assignmentSectionKeys(a: Pick<MyAssignment, "scopeKind" | "scopeLabel">): string[] {
  if (a.scopeKind !== "chapters") return []
  const dot = a.scopeLabel.lastIndexOf(" · ")
  const list = (dot >= 0 ? a.scopeLabel.slice(dot + 3) : a.scopeLabel).replace(/ in [^,]+$/, "")
  const keys = [...new Set(list.split(",").map((s) => s.trim()).filter(Boolean))]
  return keys.sort(compareSectionKeys)
}

/**
 * AQU-1510: a chapters assignment's label as a reader scans it — "MAT 1–20",
 * "LUK 22–24", "MAT 1–3, 5 · MRK 2" — instead of every key spelled out.
 *
 * A Pattani Malay translator with two assignments on one book saw two rows
 * that looked like two copies of the project: the one thing telling them apart
 * was "MAT 1, MAT 2, … MAT 28", which the table clipped from the left or
 * pushed out of view. Any other scope (a whole book, a file, "All verses")
 * keeps its label; so does a part this cannot read as "BOOK n".
 */
export function assignmentScopeText(a: Pick<MyAssignment, "scopeKind" | "scopeLabel">): string {
  const keys = assignmentSectionKeys(a)
  if (keys.length === 0) return a.scopeLabel
  const books: Array<{ book: string; chapters: number[] }> = []
  const other: string[] = []
  for (const key of keys) {
    const m = /^(\S+)\s+(\d+)$/.exec(key)
    if (!m || !isKnownBookCode(m[1])) { other.push(key); continue }
    const last = books[books.length - 1]
    if (last && last.book === m[1]) last.chapters.push(Number(m[2]))
    else books.push({ book: m[1], chapters: [Number(m[2])] })
  }
  const parts = books.map(({ book, chapters }) => {
    const runs: string[] = []
    for (let i = 0; i < chapters.length; i++) {
      let j = i
      while (j + 1 < chapters.length && chapters[j + 1] === chapters[j] + 1) j++
      runs.push(j > i ? `${chapters[i]}\u2013${chapters[j]}` : String(chapters[i]))
      i = j
    }
    return `${book} ${runs.join(", ")}`
  })
  return [...parts, ...other].join(" \u00b7 ")
}

/** Canonical book order, then chapter number; anything else by its name. */
function compareSectionKeys(a: string, b: string): number {
  const parse = (k: string) => {
    const m = /^(\S+)\s+(\d+)$/.exec(k)
    return m && isKnownBookCode(m[1]) ? { book: getBookOrdinal(m[1]), chapter: Number(m[2]) } : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa && pb) return pa.book - pb.book || pa.chapter - pb.chapter
  return a.localeCompare(b, undefined, { numeric: true })
}

/**
 * The cell a section assignment should open on, or null to open its file.
 *
 * Translation before validation, the board's own rule (`planOpenKind`): a cell
 * nobody has written cannot be validated, so the first blank cell anywhere in
 * the assignment wins over an earlier unvalidated one. A chapter whose read
 * fails counts as empty rather than failing the whole landing.
 */
export async function resolveAssignmentLandingCell(
  a: Pick<MyAssignment, "scopeKind" | "scopeLabel" | "fileId">,
  readSection: (sectionKey: string) => Promise<readonly ShortVerse[]>,
  /**
   * Media redesign slice 2: what the assignment's language delivers. An Audio
   * language lands on the first line without an approved recording (P2.2),
   * Text and audio on the first not done on both halves; Text, and a language
   * nobody has chosen for, keep the order above.
   */
  delivers?: LaneDelivers | null,
): Promise<string | null> {
  const keys = assignmentSectionKeys(a)
  if (!a.fileId || keys.length === 0) return null
  const chapters = await Promise.all(keys.map((k) => readSection(k).catch(() => [] as const)))
  const verses = chapters.flat()
  if (laneCountsAudio(delivers)) {
    const firstOpen = verses.find((v) => v.cellId && !laneLineDone(delivers, {
      textValidated: laneCountsText(delivers) ? v.validated : true,
      audioApproved: v.audioValidated === true,
    }))
    return firstOpen?.cellId ?? verses.find((v) => v.cellId)?.cellId ?? null
  }
  return shortVerses(verses, "untranslated")[0]?.cellId
    ?? shortVerses(verses, "unvalidated")[0]?.cellId
    ?? verses.find((v) => v.cellId)?.cellId
    ?? null
}
