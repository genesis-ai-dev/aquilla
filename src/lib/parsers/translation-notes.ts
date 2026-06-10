// Translation Notes (TN) TSV parser (FRO-179)
//
// Parses unfoldingWord-style Translation Notes TSV files into TranslatableString[].
//
// Standard unfoldingWord TN TSV columns (first row is header):
//   Book | Chapter | Verse | ID | SupportReference | OrigQuote | Occurrence | Note
//
// Or older format:
//   Reference | ID | Tags | SupportReference | Quote | Occurrence | Note
//
// We only strictly require the first three columns to resolve a canonical_ref.
// The parser:
// - Strips BOM
// - Detects column order from the header row (robust to column renames)
// - Constructs canonical_ref as "<book> <chapter>:<verse>"
//   (for the three-column format: cols[0] + " " + cols[1] + ":" + cols[2])
// - Note ID (4th column when named "id") → stored in metadata
// - Support reference (5th column when named "supportreference") → stored in metadata
// - All remaining columns are concatenated into the note body (tab-separated)
// - Rows that can't produce a valid canonical_ref are counted as skipped
//
// Each TSV row becomes one TranslatableString entry (one cell in Aquilla).

import { v7 as uuidv7 } from "uuid"
import type { TranslatableString } from "./types"

export interface TranslationNote {
  /** "BOOK CH:V" — e.g. "GEN 1:1" */
  canonicalRef: string
  /** unfoldingWord note id (e.g. "figs-merism"), when present */
  noteId?: string
  /** Support reference / tags (e.g. a resource container URL or tag string) */
  supportRef?: string
  /** The formatted note body (may include Markdown) */
  body: string
}

export interface TnParseResult {
  /** One entry per TSV row — suitable for importFile / emitParsedFile */
  notes: TranslationNote[]
  /** One TranslatableString per note (same order) */
  strings: TranslatableString[]
  /** Rows that were skipped because no canonical_ref could be assembled */
  skippedCount: number
}

/**
 * Parse raw TN TSV text into note cells.
 *
 * Robust to:
 * - UTF-8 BOM at the start
 * - Windows (\r\n) and Unix (\n) line endings
 * - Any column order (reads the header row)
 * - The "Reference" single-column format (splits on ":")
 * - Missing optional columns (note id, support ref)
 * - Empty trailing lines
 */
export function parseTnTsv(tsvText: string): TnParseResult {
  // Strip BOM
  if (tsvText.charCodeAt(0) === 0xfeff) tsvText = tsvText.slice(1)

  const lines = tsvText.split(/\r?\n/)
  if (lines.length < 2) {
    throw new Error("TN TSV is empty or has no data rows")
  }

  // Parse header to locate columns
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase())

  function col(names: string[]): number {
    for (const n of names) {
      const i = header.indexOf(n)
      if (i !== -1) return i
    }
    return -1
  }

  // Detect format:
  //   - "three-column" format: book / chapter / verse in first three cols
  //   - "reference" format: a single "reference" column with "ch:v" or "book ch:v"
  const iBook = col(["book"])
  const iChapter = col(["chapter", "chap", "ch"])
  const iVerse = col(["verse", "ver", "v"])
  const iReference = col(["reference", "ref"])
  const iId = col(["id"])
  const iSupportRef = col(["supportreference", "support_reference", "supportref", "tags"])

  const threeCol = iBook !== -1 && iChapter !== -1 && iVerse !== -1

  const notes: TranslationNote[] = []
  const strings: TranslatableString[] = []
  let skippedCount = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const cols = line.split("\t")

    let canonicalRef: string | null = null

    if (threeCol) {
      const book = (cols[iBook] ?? "").trim()
      const chapter = (cols[iChapter] ?? "").trim()
      const verse = (cols[iVerse] ?? "").trim()
      if (book && chapter && verse) {
        canonicalRef = `${book} ${chapter}:${verse}`
      }
    } else if (iReference !== -1) {
      // Reference column may be "ch:v" or "book ch:v"
      const raw = (cols[iReference] ?? "").trim()
      if (raw.includes(":")) {
        // If it already has a space before the colon-containing part, treat as full ref
        canonicalRef = raw.includes(" ") ? raw : null
      }
    }

    if (!canonicalRef) {
      skippedCount++
      continue
    }

    const noteId = iId !== -1 ? (cols[iId] ?? "").trim() || undefined : undefined
    const supportRef = iSupportRef !== -1 ? (cols[iSupportRef] ?? "").trim() || undefined : undefined

    // Build body from remaining columns (everything not already consumed as metadata).
    // Collect indices of known metadata columns so we can skip them for the body.
    const metaCols = new Set<number>()
    if (threeCol) {
      metaCols.add(iBook)
      metaCols.add(iChapter)
      metaCols.add(iVerse)
    } else if (iReference !== -1) {
      metaCols.add(iReference)
    }
    if (iId !== -1) metaCols.add(iId)
    if (iSupportRef !== -1) metaCols.add(iSupportRef)

    const bodyParts = cols
      .map((c, idx) => (metaCols.has(idx) ? null : c.trim()))
      .filter((c): c is string => c !== null && c.length > 0)
    const body = bodyParts.join("\t")

    const note: TranslationNote = { canonicalRef, body }
    if (noteId) note.noteId = noteId
    if (supportRef) note.supportRef = supportRef

    notes.push(note)

    // Build the section label: "BOOK CH" derived from canonicalRef "BOOK CH:V"
    const colonIdx = canonicalRef.indexOf(":")
    const section = colonIdx !== -1 ? canonicalRef.slice(0, colonIdx) : canonicalRef

    strings.push({
      id: uuidv7(),
      original: body,
      translated: "",
      context: canonicalRef,
      group: canonicalRef,
      section,
      globalReferences: [canonicalRef],
      type: "text",
    })
  }

  if (notes.length === 0 && skippedCount === 0) {
    throw new Error("TN TSV: no note rows found after parsing")
  }

  return { notes, strings, skippedCount }
}
