// Translation Notes (TN) TSV parser (AQU-179)
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
// - Note ID (column named "id") → stored in metadata
// - Support reference (column named "supportreference") → stored in metadata
// - AQU-527: the original-language phrase (OrigQuote/Quote/GLQuote) and its
//   Occurrence are pulled out as their own fields (`quote`/`occurrence`) and
//   threaded through cell metadata (`tnQuote`) so the editor sidebar can show
//   the Greek/Hebrew phrase distinctly — never mashed into the note body
// - The note body is the explicit Note/OccurrenceNote/Annotation column when
//   present, else the remaining non-metadata columns concatenated (tab-separated)
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
  /**
   * AQU-527: the original-language phrase (Greek/Hebrew) the note is about —
   * the unfoldingWord `OrigQuote`/`Quote`/`GLQuote` column. Kept OUT of `body`
   * so the editor sidebar can surface it distinctly. UW's #1 requirement:
   * without it translators are "editing blind." Absent for general notes with
   * no phrase anchor.
   */
  quote?: string
  /** Which occurrence of `quote` within the verse (UW `Occurrence` column). */
  occurrence?: string
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
  // AQU-527: the original-language phrase column (OrigQuote in the modern UW
  // format, Quote in the older one, GLQuote in some exports) and its
  // Occurrence index. Surfaced separately from the note body so the editor
  // sidebar can show the Greek/Hebrew phrase distinctly.
  const iQuote = col(["origquote", "quote", "glquote"])
  const iOccurrence = col(["occurrence", "occurrences", "occ"])
  // The human-readable note text. When the header names it explicitly (Note /
  // OccurrenceNote / Annotation) we use exactly that column as the body;
  // otherwise we fall back to concatenating the remaining non-metadata columns.
  const iNote = col(["note", "occurrencenote", "annotation", "notes"])

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
    // AQU-527: pull the original-language phrase + its occurrence out as their
    // own fields — never folded into the note body.
    const quote = iQuote !== -1 ? (cols[iQuote] ?? "").trim() || undefined : undefined
    const occurrence = iOccurrence !== -1 ? (cols[iOccurrence] ?? "").trim() || undefined : undefined

    // Collect indices of known metadata columns so we can skip them for the
    // fallback body. The phrase and occurrence join this set (AQU-527) so a
    // renamed/older TSV without an explicit Note column never mashes the
    // Greek/Hebrew phrase and the bare occurrence integer into the note text.
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
    if (iQuote !== -1) metaCols.add(iQuote)
    if (iOccurrence !== -1) metaCols.add(iOccurrence)

    // Prefer the explicitly-named Note column; otherwise concatenate whatever
    // non-metadata columns remain (legacy behavior).
    let body: string
    if (iNote !== -1) {
      body = (cols[iNote] ?? "").trim()
    } else {
      body = cols
        .map((c, idx) => (metaCols.has(idx) ? null : c.trim()))
        .filter((c): c is string => c !== null && c.length > 0)
        .join("\t")
    }

    const note: TranslationNote = { canonicalRef, body }
    if (noteId) note.noteId = noteId
    if (supportRef) note.supportRef = supportRef
    // Occurrence only means something as "which occurrence of the phrase" — so
    // it rides along only when there is a phrase to anchor it to.
    if (quote) {
      note.quote = quote
      if (occurrence) note.occurrence = occurrence
    }

    notes.push(note)

    // Build the section label: "BOOK CH" derived from canonicalRef "BOOK CH:V"
    const colonIdx = canonicalRef.indexOf(":")
    const section = colonIdx !== -1 ? canonicalRef.slice(0, colonIdx) : canonicalRef

    // AQU-527: thread the original-language phrase through the extensible
    // per-cell metadata bucket → import.ts → cells.metadata (JSONB) → the
    // TranslationNotesSidebar, which renders it above the note. No migration:
    // reuses the same bucket OBS uses for frame attachments.
    const metadata: Record<string, unknown> = {}
    if (quote) {
      metadata.tnQuote = quote
      if (occurrence) metadata.tnOccurrence = occurrence
    }

    strings.push({
      id: uuidv7(),
      original: body,
      translated: "",
      context: canonicalRef,
      group: canonicalRef,
      section,
      globalReferences: [canonicalRef],
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      type: "text",
    })
  }

  if (notes.length === 0 && skippedCount === 0) {
    throw new Error("TN TSV: no note rows found after parsing")
  }

  return { notes, strings, skippedCount }
}
