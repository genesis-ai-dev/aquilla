// Units: the pure function from one USFM book's bytes to editable segments.
//
//   cells = anyCustomFilters(tmsFriendlyFilter(fileblob))
//
// This module is `tmsFriendlyFilter`. It is deterministic: the same bytes
// always give the same unit IDs, spans and hashes, in every runtime. Nothing
// here touches disk, the network or a database.
//
// Spans are BYTE ranges into the original blob, because the write-back splices
// bytes and Paratext compares bytes. The parser underneath works on JS strings,
// so each span is translated through a UTF-16 → UTF-8 offset table built once
// per file. Version 1 supports UTF-8 projects only (Settings.xml Encoding 65001);
// any other encoding, or invalid UTF-8, is refused up front rather than guessed.
//
// Unit ID grammar (docs/plans/Aquilla ↔ Paratext Bridge.md):
//   MAT 5:3            verse text, number as written (bridges kept: "MAT 5:3-4")
//   MAT 5:12/s1#0      heading inside verse 12's span; #n = occurrence of that
//                      marker within the verse scope
//   MAT 5:0/s1#0       chapter text before \v 1 is verse 0
//   MAT 0:0/ip#2       book header / intro (chapter 0 holds \id \h \toc \ip …)
//   DEU 5:4@2          second unit in file order that would get the same ID
// IDs come from references, never from content, so they stay fixed while the
// text under them changes; the hashes are what move.

import { parseUsfmLossless } from "../parsers/usfm-lossless"
import { sha256Hex, sha256TextHex } from "./hash"
import { normalizeUnitText } from "./normalize"

/** Bump when the derivation changes in a way that alters IDs or spans. Golden
 *  tests lock the output; a bump invalidates `unit_cache` entries. */
export const PARSER_VERSION = 1

export type UnitKind = "verse" | "heading" | "paratext"

export interface UnitSpan {
  /** Byte offset of the first byte of unit text in the blob. */
  start: number
  /** Byte offset one past the last byte of unit text (exclusive). */
  end: number
}

export interface Unit {
  /** `MAT 5:3`, `MAT 5:12/s1#0`, `MAT 0:0/ip#2`. */
  id: string
  kind: UnitKind
  book: string
  chapter: number
  /** Verse number as written ("3", "3-4", "0" for pre-verse-1 material). */
  verse: string
  /** Marker name for non-verse units ("s1", "ip"); undefined for verses. */
  marker?: string
  /** The importer's reference for the same segment (`parseUsfmLossless`'s
   *  `ref`: `MAT 5:3` for verses, `MAT 5:s1:3` for headings) — how a cell in
   *  a mirrored Aquilla project (`canonicalRef`) finds its unit. Equal to `id`
   *  for verses; headings count differently, hence the separate field. */
  ref: string
  /** The unit's text exactly as the bytes decode, trailing line break trimmed. */
  text: string
  span: UnitSpan
  /** SHA-256 of the exact bytes in `span`. Guards write-back. */
  rawHash: string
  /** SHA-256 of `normalizeUnitText(text)`. Drives staleness and TM lookup. */
  textHash: string
}

export interface UnitSet {
  parserVersion: number
  book: string
  blobHash: string
  /** Whether the blob started with a UTF-8 BOM (EF BB BF). Preserved on write. */
  hasBom: boolean
  /** Dominant line ending, preserved on write. */
  lineEnding: "\r\n" | "\n"
  units: Unit[]
}

export class UnitDeriveError extends Error {
  readonly code: "invalid-utf8" | "no-id"
  constructor(message: string, code: "invalid-utf8" | "no-id") {
    super(message)
    this.name = "UnitDeriveError"
    this.code = code
  }
}

const BOM = new Uint8Array([0xef, 0xbb, 0xbf])

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
}

/** Decode UTF-8 strictly, keeping a BOM as U+FEFF so string offsets line up
 *  with the file from its first byte. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new UnitDeriveError("File is not valid UTF-8; version 1 of the bridge supports UTF-8 projects only", "invalid-utf8")
  }
}

/** Table mapping each UTF-16 index (0..=text.length) to its UTF-8 byte offset. */
export function utf16ToUtf8Offsets(text: string): Uint32Array {
  const table = new Uint32Array(text.length + 1)
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    table[i] = bytes
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: the pair encodes as 4 bytes; charge them all here and
      // give the low surrogate the same byte offset as the end of the pair.
      bytes += 4
      if (i + 1 < text.length) { i++; table[i] = bytes }
    } else bytes += 3
  }
  table[text.length] = bytes
  return table
}

function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf >= lf && crlf > 0 ? "\r\n" : "\n"
}

/** Trim trailing CR/LF/space/tab off a string span so the line break that
 *  follows a unit stays outside it (the splice must never eat a newline). */
function trimSpanEnd(text: string, start: number, end: number): number {
  let e = end
  while (e > start) {
    const c = text.charCodeAt(e - 1)
    if (c === 0x0d || c === 0x0a || c === 0x20 || c === 0x09) e--
    else break
  }
  return e
}

interface Draft {
  id: string
  kind: UnitKind
  book: string
  chapter: number
  verse: string
  marker?: string
  ref: string
  text: string
  charStart: number
  charEnd: number
}

/**
 * Derive units from one book file. Pure; the only async part is hashing.
 */
export async function deriveUnits(bytes: Uint8Array): Promise<UnitSet> {
  const hasBom = hasUtf8Bom(bytes)
  const text = decodeUtf8Strict(bytes)
  const doc = parseUsfmLossless(text)
  if (!doc.bookId) throw new UnitDeriveError("File has no \\id marker", "no-id")
  const book = doc.bookId

  const drafts: Draft[] = []

  // Verses first — they also define the scopes headings fall into.
  const verseScopes: { chapter: number; verse: string; start: number }[] = []
  for (const v of doc.verses) {
    const end = trimSpanEnd(text, v.textStart, v.textEnd)
    drafts.push({
      id: `${book} ${v.chapter}:${v.number}`,
      kind: "verse",
      book,
      chapter: v.chapter,
      verse: v.number,
      ref: v.ref,
      text: text.slice(v.textStart, end),
      charStart: v.textStart,
      charEnd: end,
    })
    verseScopes.push({ chapter: v.chapter, verse: v.number, start: v.markerStart })
  }

  // Headings / paratext: scope = the last verse of the same chapter whose
  // marker precedes the heading (a heading ends that verse's text span, so it
  // sits at the span's end, not inside it); none → verse 0 of the heading's
  // chapter (chapter 0 = book header). Occurrence index counts the same marker
  // within one scope.
  const occurrence = new Map<string, number>()
  for (const h of doc.headings) {
    let scopeVerse = "0"
    const scopeChapter = h.chapter
    for (const s of verseScopes) {
      if (s.chapter !== h.chapter || s.start > h.markerStart) continue
      scopeVerse = s.verse
    }
    const scopeKey = `${scopeChapter}:${scopeVerse}/${h.marker}`
    const n = occurrence.get(scopeKey) ?? 0
    occurrence.set(scopeKey, n + 1)
    const end = trimSpanEnd(text, h.textStart, h.textEnd)
    drafts.push({
      id: `${book} ${scopeChapter}:${scopeVerse}/${h.marker}#${n}`,
      kind: h.kind,
      book,
      chapter: scopeChapter,
      verse: scopeVerse,
      marker: h.marker,
      ref: h.ref,
      text: text.slice(h.textStart, end),
      charStart: h.textStart,
      charEnd: end,
    })
  }

  drafts.sort((a, b) => a.charStart - b.charStart)

  // Real projects do carry duplicate references (a chapter with two `\v 4`).
  // The first keeps the plain ID; later ones get `@2`, `@3` … in file order, so
  // every unit is addressable and the result is still deterministic.
  const seen = new Map<string, number>()
  for (const d of drafts) {
    const n = (seen.get(d.id) ?? 0) + 1
    seen.set(d.id, n)
    if (n > 1) d.id = `${d.id}@${n}`
  }

  const table = utf16ToUtf8Offsets(text)
  const units: Unit[] = await Promise.all(
    drafts.map(async (d) => {
      const span = { start: table[d.charStart], end: table[d.charEnd] }
      const [rawHash, textHash] = await Promise.all([
        sha256Hex(bytes.subarray(span.start, span.end)),
        sha256TextHex(normalizeUnitText(d.text)),
      ])
      return {
        id: d.id, kind: d.kind, book: d.book, chapter: d.chapter, verse: d.verse,
        ...(d.marker ? { marker: d.marker } : {}),
        ref: d.ref, text: d.text, span, rawHash, textHash,
      }
    }),
  )

  return {
    parserVersion: PARSER_VERSION,
    book,
    blobHash: await sha256Hex(bytes),
    hasBom,
    lineEnding: detectLineEnding(text),
    units,
  }
}

/** Full overlay key: `pt:{projectGuid}:{unitId}`. */
export function unitKey(projectGuid: string, unitId: string): string {
  return `pt:${projectGuid}:${unitId}`
}
