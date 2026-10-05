/**
 * AQU-1365: which project file a translation import goes into.
 *
 * The Import dialog's "A translation" path asks "Which file does it
 * translate?" with the open file preselected, and the import goes where the
 * person says. An upload's own book never moves it: Sam's ruling on the PR 3
 * pass was "we should be following the user while informing them, not
 * leading them". The review says when an upload is for another book and
 * offers that book's file ("Import into Ruth instead"), and an upload held
 * while no file is chosen offers the file its book is in
 * (`suggestTranslationDestination`), one click away but never taken for them.
 */

import { decodeImportText } from "@/lib/import/ai-recipe"
import { parseCsvRows, parseXlsxToSheets } from "@/lib/parsers/spreadsheet"
import { parseVerseReference } from "@/lib/scripture-reference"
import { fileBookCode, type GroupableFile } from "@/lib/sidebar/group-by-corpus"

/** A project file the translation can go into. */
export interface TranslationDestination extends GroupableFile {
  id: string
}

const USFM_EXTENSIONS = new Set(["usfm", "sfm", "usf"])

/** The formats the translation review (FileTargetImportPanel) reads. */
export const FILE_TARGET_EXTENSIONS = ["usfm", "sfm", "usf", "csv", "tsv", "xlsx", "vtt", "srt", "sbv"] as const

/** The same, as an `<input accept>` list. */
export const FILE_TARGET_ACCEPT = FILE_TARGET_EXTENSIONS.map((ext) => `.${ext}`).join(",")

/** True when the translation review can read this file. */
export function isFileTargetFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".")
  return dot >= 0 && (FILE_TARGET_EXTENSIONS as readonly string[]).includes(fileName.slice(dot + 1).toLowerCase())
}

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

/** A reference cell is short ("1 Thessalonians 12:34-35"); a longer cell is
 *  text, and is not run through the reference parser. */
const MAX_REFERENCE_LENGTH = 40

/** A column is a reference column when at least this share of its filled
 *  cells read as verse references, so a translation that happens to quote
 *  "John 3:16" doesn't name a book. */
const REFERENCE_COLUMN_SHARE = 0.5

/**
 * The books a spreadsheet's reference column names, in order of first
 * appearance, or none when no column reads as references. The column is found
 * by its contents, not its header: the one with the most cells that read as
 * verse references (`GEN 1:1`, `Genesis 1:1`, `gen 1.1`), provided they are
 * at least half of its filled cells.
 */
export function sheetBookIds(rows: readonly (readonly string[])[]): string[] {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  let best: string[] = []
  let bestCount = 0
  for (let col = 0; col < width; col++) {
    let filled = 0
    let refs = 0
    const books: string[] = []
    for (const row of rows) {
      const value = row[col]?.trim()
      if (!value) continue
      filled++
      if (value.length > MAX_REFERENCE_LENGTH) continue
      const verse = parseVerseReference(value)
      if (!verse) continue
      refs++
      if (!books.includes(verse.bookCode)) books.push(verse.bookCode)
    }
    if (refs > bestCount && refs >= REFERENCE_COLUMN_SHARE * filled) {
      best = books
      bestCount = refs
    }
  }
  return best
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".")
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ""
}

/**
 * The books an upload for the translation review names: a USFM file's `\id`
 * lines, or a spreadsheet's reference column (every sheet of a workbook).
 * Subtitles name no book. A file that can't be read names none either: the
 * review reports what is wrong with it once the person starts it.
 */
export async function uploadBookIds(file: File): Promise<string[]> {
  const ext = extensionOf(file.name)
  try {
    if (USFM_EXTENSIONS.has(ext)) return usfmBookIds(decodeImportText(await file.arrayBuffer(), file.name))
    if (ext === "csv" || ext === "tsv") {
      return sheetBookIds(parseCsvRows(decodeImportText(await file.arrayBuffer(), file.name)))
    }
    if (ext === "xlsx") {
      const sheets = await parseXlsxToSheets(await file.arrayBuffer())
      return [...new Set(sheets.flatMap((sheet) => sheetBookIds(sheet.rows)))]
    }
  } catch {
    return []
  }
  return []
}

/**
 * What the dialog can say about where a held upload goes, from the books it
 * names. Only `file` offers a destination: one book, held by exactly one
 * project file. Two files of one book (a pilot's two Jonahs) or none are said
 * as such and leave the choice to the picker. An upload naming no book, or
 * several, gets null: there is nothing to say.
 */
export type TranslationSuggestion =
  | { kind: "file"; bookCode: string; file: TranslationDestination }
  | { kind: "several"; bookCode: string }
  | { kind: "none"; bookCode: string }

export function suggestTranslationDestination(
  files: readonly TranslationDestination[],
  uploadBookIds: readonly string[],
): TranslationSuggestion | null {
  if (uploadBookIds.length !== 1) return null
  const bookCode = uploadBookIds[0].toUpperCase()
  const matches = filesForBook(files, bookCode)
  if (matches.length === 1) return { kind: "file", bookCode, file: matches[0] }
  return { kind: matches.length === 0 ? "none" : "several", bookCode }
}
