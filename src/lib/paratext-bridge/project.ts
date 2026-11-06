// A Paratext project folder as the bridge sees it: Settings.xml plus the book
// files it names. Pure helpers over the parsed settings; file I/O is the
// Tauri side's job.

import { parseParatextSettings, type ParatextSettings } from "../parsers/paratext"
import { BOOK_CODES_BY_NUMBER } from "./book-codes"

export { parseParatextSettings }
export type { ParatextSettings }

export const UTF8_CODEPAGE = "65001"

export function isUtf8Project(s: ParatextSettings): boolean {
  return !s.encoding || s.encoding.trim() === UTF8_CODEPAGE
}

/** Paratext's file-name number for a code: GEN=01 … MAL=39, MAT=41 (40 is
 *  skipped) … REV=67, TOB=68 … XXG=100, then FRT=A0, BAK=A1 … INT=A7, TDX=B0,
 *  LAO=C3. */
export function bookNumberToken(code: string): string | undefined {
  const i = BOOK_CODES_BY_NUMBER.indexOf(code.toUpperCase())
  if (i < 0) return undefined
  const n = i < 39 ? i + 1 : i + 2
  if (n <= 100) return String(n).padStart(2, "0")
  const letter = String.fromCharCode("A".charCodeAt(0) + Math.floor((n - 101) / 10))
  return `${letter}${(n - 101) % 10}`
}

/** File name for a book under the project's <Naming>: PrePart + bookNameForm
 *  rendered for the code + PostPart. BookNameForm is one of "41MAT", "MAT", "41". */
export function bookFileName(s: ParatextSettings, code: string): string | undefined {
  const num = bookNumberToken(code)
  if (!num) return undefined
  const form = s.naming.bookNameForm || "41MAT"
  let middle: string
  if (/^(?:\d{2,3}|[A-Z]\d)[A-Z0-9]{3}$/.test(form)) middle = `${num}${code.toUpperCase()}`
  else if (/^[A-Z0-9]{3}$/.test(form)) middle = code.toUpperCase()
  else if (/^(?:\d{2,3}|[A-Z]\d)$/.test(form)) middle = num
  else middle = `${num}${code.toUpperCase()}`
  return `${s.naming.prePart}${middle}${s.naming.postPart}`
}

/** Book codes whose bit is set in <BooksPresent>. */
export function booksPresent(s: ParatextSettings): string[] {
  const bits = s.booksPresent ?? ""
  const out: string[] = []
  for (let i = 0; i < bits.length && i < BOOK_CODES_BY_NUMBER.length; i++) {
    if (bits[i] === "1") out.push(BOOK_CODES_BY_NUMBER[i])
  }
  return out
}

/** Does `fileName` look like one of this project's book files? Returns the code. */
export function bookCodeFromProjectFile(s: ParatextSettings, fileName: string): string | undefined {
  const { prePart, postPart } = s.naming
  if (prePart && !fileName.startsWith(prePart)) return undefined
  if (postPart && !fileName.toUpperCase().endsWith(postPart.toUpperCase())) return undefined
  const middle = fileName.slice(prePart.length, fileName.length - postPart.length)
  const m = middle.match(/^(?:\d{2,3}|[A-Z]\d)?([A-Z0-9]{3})$/i)
  if (m && BOOK_CODES_BY_NUMBER.includes(m[1].toUpperCase())) return m[1].toUpperCase()
  const n = middle.match(/^(\d{2,3}|[A-Z]\d)$/)
  if (n) {
    const idx = BOOK_CODES_BY_NUMBER.findIndex((c) => bookNumberToken(c) === n[1])
    if (idx >= 0) return BOOK_CODES_BY_NUMBER[idx]
  }
  return undefined
}
