/**
 * AQU-1365: which project file a translation import goes into.
 *
 * The Import dialog's "A translation" path asks "Which file does it
 * translate?" with the open file preselected. A dropped USFM file names its
 * own book on its `\id` line, so when the person has not picked a file
 * themselves and exactly one project file holds that book, the import goes
 * there instead (the way Codex's eBible import picks the book). A choice the
 * person made is never overridden: the review's wrong-book sentence covers
 * that case.
 */

import { fileBookCode, type GroupableFile } from "@/lib/sidebar/group-by-corpus"

/** A project file the translation can go into. */
export interface TranslationDestination extends GroupableFile {
  id: string
}

const USFM_EXTENSIONS = new Set(["usfm", "sfm", "usf"])

export function isUsfmFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".")
  return dot >= 0 && USFM_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase())
}

/**
 * Every book a USFM text names on an `\id` line, uppercased, in file order
 * and without repeats. `\id` is a line-start marker, so the whole text is
 * scanned: a file holding two books carries its second `\id` far below the
 * first book's chapters, and must read as two books, not one.
 */
export function usfmBookIds(text: string): string[] {
  const ids: string[] = []
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (const match of body.matchAll(/^[ \t]*\\id[ \t]+([A-Za-z0-9]{3})(?![A-Za-z0-9])/gm)) {
    const code = match[1].toUpperCase()
    if (!ids.includes(code)) ids.push(code)
  }
  return ids
}

/** The project files that hold `bookCode`. */
export function filesForBook<T extends TranslationDestination>(files: readonly T[], bookCode: string): T[] {
  const wanted = bookCode.toUpperCase()
  return files.filter((file) => fileBookCode(file)?.toUpperCase() === wanted)
}

/**
 * Where a dropped file goes, or null when nothing is chosen yet (the dialog
 * then holds the file until the person picks one).
 *
 * The upload's book moves the destination only when all of these hold: the
 * person has not touched the picker, the upload names exactly one book, and
 * exactly one project file holds it. Two `\id` lines, or a book two files
 * share (a pilot's two Jonahs), pick nothing.
 */
export function pickTranslationDestination(input: {
  files: readonly TranslationDestination[]
  /** The destination chosen so far (the open file, or the person's pick). */
  current: string | null
  /** True once the person has chosen a file in this dialog. */
  touched: boolean
  /** `usfmBookIds` of the upload; empty for anything but USFM. */
  uploadBookIds: readonly string[]
}): { id: string; autoPicked: boolean } | null {
  const { files, current, touched, uploadBookIds } = input
  const known = current !== null && files.some((file) => file.id === current) ? current : null
  if (!touched && uploadBookIds.length === 1) {
    const matches = filesForBook(files, uploadBookIds[0])
    if (matches.length === 1) {
      return { id: matches[0].id, autoPicked: matches[0].id !== known }
    }
  }
  return known === null ? null : { id: known, autoPicked: false }
}
