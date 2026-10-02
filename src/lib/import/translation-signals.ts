/**
 * AQU-1365: does an upload on the New source text path look like a
 * translation of a file already in this project?
 *
 * On the Siberian Tatar pilot a finished Jonah translation went through the
 * source import and became a second Jonah source file. Before the preview,
 * the Import dialog now checks every text upload for two explicit signals and
 * asks the person when either fires:
 *
 *  - Its book is already here: a USFM upload's `\id` book matches a project
 *    file's book (`fileBookCode`, which falls back to the file name for files
 *    migrated without one).
 *  - It says it is in the target language: the USFM `\id`/`\rem` header or the
 *    WebVTT header names one of the project's target languages, and does NOT
 *    also name the source language (`\id PSA EN_ULT en_English_ltr` in an
 *    English project is a source text, whatever else it says).
 *
 * Only explicit signals count. A file that says nothing about its language
 * and holds a book the project doesn't have is imported as before, so a clear
 * source import gains no click.
 */

import { languageSurfaceForms, languagesEqual } from "@/lib/language-normalize"
import type { LanguageEntry } from "@/lib/languages/catalog"
import { filesForBook, type TranslationDestination } from "@/lib/import/translation-destination"

/**
 * The language-bearing parts of an upload's header.
 *
 * `fields` hold structured values (the rest of a USFM `\id` line, a WebVTT
 * `Language:` value): a two-letter code like `fr` only counts there. `notes`
 * hold free text (`\rem` lines, the words after `WEBVTT`), where a two-letter
 * code is too often an ordinary word ("it", "no", "to") to mean anything.
 */
export interface UploadHeader {
  fields: string[]
  notes: string[]
}

export const EMPTY_UPLOAD_HEADER: UploadHeader = { fields: [], notes: [] }

const USFM_EXTENSIONS = new Set(["usfm", "sfm", "usf"])

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".")
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ""
}

/** True for the formats whose header can name a language (USFM, WebVTT). */
export function hasLanguageHeader(fileName: string): boolean {
  const ext = extensionOf(fileName)
  return USFM_EXTENSIONS.has(ext) || ext === "vtt"
}

/**
 * The language-bearing header of an upload's text. USFM: what follows the
 * book code on every `\id` line, and every `\rem` line, before the first
 * chapter. WebVTT: the words after `WEBVTT` and every `Language:` value in the
 * header block (up to the first blank line). Anything else has no header.
 */
export function uploadHeaderText(fileName: string, text: string): UploadHeader {
  const ext = extensionOf(fileName)
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split(/\r\n|\r|\n/)
  const header: UploadHeader = { fields: [], notes: [] }
  if (USFM_EXTENSIONS.has(ext)) {
    for (const line of lines) {
      const trimmed = line.trim()
      if (/^\\c(?:\s|$)/.test(trimmed)) break
      const id = /^\\id\s+[A-Za-z0-9]{3}(?![A-Za-z0-9])(.*)$/.exec(trimmed)
      if (id) {
        if (id[1].trim()) header.fields.push(id[1].trim())
        continue
      }
      const rem = /^\\rem(?:\s+(.*))?$/.exec(trimmed)
      if (rem?.[1]?.trim()) header.notes.push(rem[1].trim())
    }
    return header
  }
  if (ext === "vtt") {
    const first = lines[0]?.trim() ?? ""
    if (!/^WEBVTT(?:\s|$)/.test(first)) return header
    const title = first.slice("WEBVTT".length).replace(/^[\s-]+/, "").trim()
    if (title) header.notes.push(title)
    for (const line of lines.slice(1)) {
      const trimmed = line.trim()
      if (!trimmed) break
      const language = /^language\s*:\s*(.+)$/i.exec(trimmed)
      if (language) header.fields.push(language[1].trim())
    }
  }
  return header
}

/** Lowercase, without diacritics, split into letter runs. */
function words(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
}

/** True when `phrase`'s words appear in `tokens` side by side, in order. */
function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false
  for (let start = 0; start + phrase.length <= tokens.length; start++) {
    if (phrase.every((word, offset) => tokens[start + offset] === word)) return true
  }
  return false
}

/**
 * Every way a header might write `language`: its stored name, the names and
 * codes `languagesEqual` treats as the same, and the catalog's name and codes
 * for it (so a project whose target is "Siberian Tatar" recognises `sty`).
 * Two-letter codes are kept apart (see `UploadHeader`).
 */
function languageForms(language: string, catalog: readonly LanguageEntry[]): { phrases: string[][]; shortCodes: Set<string> } {
  const raw = new Set<string>(languageSurfaceForms(language))
  const folded = words(language).join(" ")
  const lower = language.trim().toLowerCase()
  for (const entry of catalog) {
    const name = words(entry.name).join(" ")
    if (name === folded || entry.code === lower || entry.altCode === lower) {
      raw.add(entry.name)
      raw.add(entry.code)
      if (entry.altCode) raw.add(entry.altCode)
    }
  }
  const phrases: string[][] = []
  const shortCodes = new Set<string>()
  for (const form of raw) {
    const parts = words(form)
    if (parts.length === 0) continue
    if (parts.length === 1 && parts[0].length <= 2) shortCodes.add(parts[0])
    else phrases.push(parts)
  }
  return { phrases, shortCodes }
}

/**
 * A test for whether a header names `language`, as a whole word or phrase.
 * Built once per language: the catalog scan is the costly part.
 */
export function languageMatcher(
  language: string,
  catalog: readonly LanguageEntry[] = [],
): (header: UploadHeader) => boolean {
  if (!language.trim()) return () => false
  const { phrases, shortCodes } = languageForms(language, catalog)
  return (header) => {
    const fieldTokens = header.fields.map(words)
    const named = [...fieldTokens, ...header.notes.map(words)].some((tokens) =>
      phrases.some((phrase) => containsPhrase(tokens, phrase)),
    )
    if (named) return true
    return fieldTokens.some((tokens) => tokens.some((token) => shortCodes.has(token)))
  }
}

/** True when the header names `language`, as a whole word or phrase. */
export function mentionsLanguage(
  header: UploadHeader,
  language: string,
  catalog: readonly LanguageEntry[] = [],
): boolean {
  return languageMatcher(language, catalog)(header)
}

/** One text upload, as the check sees it. */
export interface TranslationCheckUpload {
  /** Unique within one batch (the file name). */
  fileKey: string
  fileName: string
  /** The books its parsed results carry, uppercased (USFM `\id`). */
  bookIds: string[]
  header: UploadHeader
  /** Its import keys (file name and result names lowercased, book codes
   *  uppercased), the ones the collision screen's choices are keyed by. */
  importKeys: string[]
}

/** Why one upload was flagged. */
export interface TranslationSignal {
  fileKey: string
  fileName: string
  bookIds: string[]
  /** For each of its books already in the project, the files that hold it. */
  sameBook: { bookCode: string; files: { id: string; name: string }[] }[]
  /** The project target language its header names, when it names one (and
   *  not the source language). */
  language?: string
}

export function translationSignals(input: {
  uploads: readonly TranslationCheckUpload[]
  existingFiles: readonly TranslationDestination[]
  sourceLanguage: string
  targetLanguages: readonly string[]
  /** Import keys the person already answered about (the collision screen). */
  skipImportKeys?: ReadonlySet<string>
  /** Language names and codes beyond `languagesEqual`'s short list. */
  catalog?: readonly LanguageEntry[]
}): TranslationSignal[] {
  const { uploads, existingFiles, sourceLanguage, targetLanguages, skipImportKeys, catalog = [] } = input
  // A translation goes into a file that's already here, so an empty project
  // has nothing to suggest instead.
  if (existingFiles.length === 0) return []
  const targets = targetLanguages
    .filter(
      (language, index) =>
        language.trim()
        && !languagesEqual(language, sourceLanguage)
        && targetLanguages.findIndex((other) => languagesEqual(other, language)) === index,
    )
    .map((language) => ({ language, named: languageMatcher(language, catalog) }))
  const namesSource = languageMatcher(sourceLanguage, catalog)
  const signals: TranslationSignal[] = []
  for (const upload of uploads) {
    if (skipImportKeys && upload.importKeys.some((key) => skipImportKeys.has(key))) continue
    const sameBook = upload.bookIds
      .map((bookCode) => ({
        bookCode,
        files: filesForBook(existingFiles, bookCode).map((file) => ({ id: file.id, name: file.name })),
      }))
      .filter((match) => match.files.length > 0)
    const hasHeader = upload.header.fields.length > 0 || upload.header.notes.length > 0
    const language = hasHeader && !namesSource(upload.header)
      ? targets.find((target) => target.named(upload.header))?.language
      : undefined
    if (sameBook.length === 0 && !language) continue
    signals.push({
      fileKey: upload.fileKey,
      fileName: upload.fileName,
      bookIds: upload.bookIds,
      sameBook,
      ...(language ? { language } : {}),
    })
  }
  return signals
}

/** Which of the check screen's layouts a set of findings gets. */
export type TranslationCheckLayout =
  /** One file, one book, already here in exactly one file: translation,
   *  update, or separate. */
  | { kind: "sameBook"; signal: TranslationSignal; book: { bookCode: string; file: { id: string; name: string } } }
  /** One file whose one book more than one project file holds. */
  | { kind: "sameBookAmbiguous"; signal: TranslationSignal; bookName: string }
  /** One file holding several books, some already here. */
  | { kind: "multiBook"; signal: TranslationSignal }
  /** One file whose only signal is its declared language. */
  | { kind: "language"; signal: TranslationSignal }
  /** Several files uploaded together, some of them flagged. */
  | { kind: "many"; signals: TranslationSignal[] }

export function translationCheckLayout(signals: readonly TranslationSignal[], fileCount: number): TranslationCheckLayout {
  if (signals.length !== 1 || fileCount > 1) return { kind: "many", signals: [...signals] }
  const signal = signals[0]
  if (signal.sameBook.length === 0) return { kind: "language", signal }
  if (signal.bookIds.length > 1) return { kind: "multiBook", signal }
  const match = signal.sameBook[0]
  if (match.files.length === 1) {
    return { kind: "sameBook", signal, book: { bookCode: match.bookCode, file: match.files[0] } }
  }
  return { kind: "sameBookAmbiguous", signal, bookName: match.files[0].name }
}

/** What the person answered on the check screen (also its telemetry value). */
export type TranslationCheckChoice =
  | "translation"
  | "update"
  | "separate"
  | "choose-file"
  | "leave-out"
  | "import-all"
  | "back"

/** Which signals fired across a batch, for telemetry. */
export function translationCheckSignal(signals: readonly TranslationSignal[]): "book" | "language" | "both" {
  const book = signals.some((signal) => signal.sameBook.length > 0)
  const language = signals.some((signal) => signal.language)
  return book && language ? "both" : book ? "book" : "language"
}
