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
// The inbox row carries no cell ids — the server sends the scope as a label
// — so the cells are read on the click, one chapter at a time, from the same
// per-chapter read the board's chapter card draws its chips from. That read
// already places headings and lines added in the editor in their chapter, so
// the landing agrees with the chips a manager sees for the same chapter.

import type { MyAssignment } from "@/lib/sync/assignments"
import { getBookOrdinal, isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
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
): Promise<string | null> {
  const keys = assignmentSectionKeys(a)
  if (!a.fileId || keys.length === 0) return null
  const chapters = await Promise.all(keys.map((k) => readSection(k).catch(() => [] as const)))
  const verses = chapters.flat()
  return shortVerses(verses, "untranslated")[0]?.cellId
    ?? shortVerses(verses, "unvalidated")[0]?.cellId
    ?? verses.find((v) => v.cellId)?.cellId
    ?? null
}
