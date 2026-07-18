// Shared TSV helpers for the notes/questions resource routes (spec §4).
//
// The unfoldingWord TSV resources (tn/tq/sn/sq) share a column model:
//   Reference | ID | Tags | SupportReference | Quote | Occurrence | <prose…>
// where <prose…> is `Note` for notes and `Question`(+`Response`) for questions.
//
// The cell-id seed is `${repo}|${book}|${rowID}` using the TSV `ID` column,
// which unfoldingWord guarantees stable per row (spec §4/§5) — so a re-import
// derives the same id even when a note's prose changes, making the delta a
// commit (not churn). We parse columns directly here (header-driven) rather than
// reusing translation-notes.ts, because the spec requires column-precise
// metadata (SupportReference/Quote/Occurrence/Tags) and prose isolation that the
// looser TN parser does not preserve.

/** One parsed TSV data row, header-resolved. */
export interface TsvRow {
  /** The TSV `ID` column value (stable per row). */
  rowId: string
  /** Raw `Reference` cell, e.g. "1:1" or "front:intro". */
  reference: string
  /** Untranslated columns to carry in `cell.metadata` (only present keys). */
  metadata: Record<string, string>
  /** Named prose columns keyed by lowercased header (e.g. note/question/response). */
  prose: Record<string, string>
}

const META_HEADERS = new Set(["tags", "supportreference", "quote", "occurrence", "origquote"])
/** Header → canonical metadata key for the carried columns. */
const META_KEY: Record<string, string> = {
  tags: "tags",
  supportreference: "supportReference",
  quote: "quote",
  origquote: "quote",
  occurrence: "occurrence",
}

export interface ParsedTsv {
  /** Header cells, lowercased+trimmed, in file order. */
  header: string[]
  rows: TsvRow[]
  /** Rows skipped because they had no usable `ID`. */
  skippedCount: number
}

/**
 * Parse a unfoldingWord-style TSV into header-resolved rows. Robust to a leading
 * BOM and CRLF/LF line endings. Structural (`ID`/`Reference`/`Tags`/
 * `SupportReference`/`Quote`/`Occurrence`) columns are separated from prose
 * columns; the caller decides which prose column(s) are translatable.
 *
 * A row with a blank `ID` is skipped (it has no stable identity — spec §5).
 */
export function parseResourceTsv(tsvText: string): ParsedTsv {
  let text = tsvText
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const lines = text.split(/\r?\n/)
  const headerLine = lines.find((l) => l.trim().length > 0)
  if (headerLine === undefined) {
    return { header: [], rows: [], skippedCount: 0 }
  }
  const header = headerLine.split("\t").map((h) => h.trim().toLowerCase())
  const idx = (name: string): number => header.indexOf(name)

  const iId = idx("id")
  const iReference = ((): number => {
    const r = idx("reference")
    return r !== -1 ? r : idx("ref")
  })()

  const rows: TsvRow[] = []
  let skippedCount = 0

  let seenHeader = false
  for (const line of lines) {
    if (line.trim().length === 0) continue
    if (!seenHeader) {
      seenHeader = true // the first non-empty line is the header
      continue
    }
    const cols = line.split("\t")

    const rowId = iId !== -1 ? (cols[iId] ?? "").trim() : ""
    if (!rowId) {
      skippedCount++
      continue
    }

    const reference = iReference !== -1 ? (cols[iReference] ?? "").trim() : ""

    const metadata: Record<string, string> = {}
    const prose: Record<string, string> = {}
    for (let c = 0; c < header.length; c++) {
      const key = header[c]
      const val = (cols[c] ?? "").trim()
      if (key === "id" || key === "reference" || key === "ref") continue
      if (META_HEADERS.has(key)) {
        if (val) metadata[META_KEY[key] ?? key] = val
      } else {
        // Prose column (note / question / response / anything else). Keep even
        // when empty so the caller can detect presence of the column.
        prose[key] = val
      }
    }

    rows.push({ rowId, reference, metadata, prose })
  }

  return { header, rows, skippedCount }
}

const BOOK_ID_RE = /\b([1-3]?[A-Za-z]{2,3})\b/

/**
 * Derive a book code for the cell-id seed. Prefers a `BOOK` token embedded in
 * the `Reference` (rare — unfoldingWord references are usually chapter:verse
 * only), otherwise falls back to the book code in the file name
 * (`tn_TIT.tsv`, `57-tit.tsv`, `en_tq_57-TIT.tsv`, `tq_OBS.tsv` → "TIT"/"OBS").
 * Always UPPERCASED so the seed is stable across filename casing.
 */
export function bookCodeFromTsv(path: string, sampleReference: string): string {
  // A reference like "GEN 1:1" carries the book; "1:1" does not.
  if (sampleReference.includes(" ")) {
    const first = sampleReference.split(/\s+/)[0]
    if (first && /^[1-3]?[A-Za-z]{2,4}$/.test(first)) return first.toUpperCase()
  }
  const base = (path.split("/").pop() ?? path).replace(/\.tsv$/i, "")
  // Take the last underscore/hyphen-delimited token that looks like a book id.
  const tokens = base.split(/[_-]/).filter(Boolean)
  for (let t = tokens.length - 1; t >= 0; t--) {
    const m = tokens[t].match(BOOK_ID_RE)
    if (m && !/^\d+$/.test(tokens[t])) return m[1].toUpperCase()
  }
  return base.toUpperCase()
}

/** Build the "BOOK CH:V" canonical ref from a book code + TSV `Reference` cell. */
export function canonicalRefFromTsv(book: string, reference: string): string {
  if (!reference) return book
  // A reference that already includes a space is treated as a full ref.
  return reference.includes(" ") ? reference : `${book} ${reference}`
}
