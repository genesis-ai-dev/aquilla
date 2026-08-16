/**
 * CSV/TSV bilingual importer.
 *
 * Column heuristic:
 *   - 2 columns:  col[0]=source, col[1]=target
 *   - 3+ columns: if col[0] looks like an id (no spaces, short, ascii-ish),
 *                 col[0]=id, col[1]=source, col[2]=target.
 *                 Otherwise col[0]=source, col[1]=target (id column ignored).
 *   - 4th column: treated as context/note and appended to the `context` field
 *                 when the header names it "context", "note", "notes",
 *                 "comment", or "comments"; or when there is no header and a
 *                 4th column is present (positional fallback).
 *   - 5th+ columns: currently ignored (preserved for future use).
 *
 * Header row detection: if the first row has no cell that starts with a digit
 * and none of the cells match a bilingual-field name heuristic, and all cells
 * are short ASCII strings, we treat it as a header and skip it.
 *
 * RFC-4180 quoting: double-quoted fields, embedded quotes escaped as "",
 * embedded newlines inside quotes are preserved.
 *
 * BOM handling: leading UTF-8 BOM (U+FEFF) is stripped from the input string.
 * When Excel exports UTF-16 CSVs, the caller's TextDecoder preserves the BOM
 * character in the resulting string — we strip it here so the first cell is
 * not corrupted.
 */

import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./core-types"

// ─── RFC-4180 parser ─────────────────────────────────────────────────────────

/**
 * Parse a single CSV/TSV string into rows of fields.
 * Handles:
 *   - Comma and tab delimiters (auto-detected)
 *   - Double-quoted fields with embedded commas, tabs, newlines
 *   - Doubled-quote escaping inside quoted fields ("")
 */
export function parseCsvRows(text: string): string[][] {
  // Strip leading BOM (U+FEFF) — present in UTF-8 BOM and UTF-16 files after
  // TextDecoder decodes them. Without this strip, the first field of the first
  // row starts with an invisible BOM character that breaks header detection and
  // column name matching.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }

  // Detect delimiter: if tabs are more prevalent than commas in the first
  // 1024 chars, use tab; otherwise use comma.
  const sample = text.slice(0, 1024)
  const tabCount = (sample.match(/\t/g) || []).length
  const commaCount = (sample.match(/,/g) || []).length
  const delimiter = tabCount > commaCount ? "\t" : ","

  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuote = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]

    if (inQuote) {
      if (ch === '"') {
        // Peek ahead: doubled quote = literal quote char
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        // Closing quote
        inQuote = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    // Not in quote
    if (ch === '"') {
      inQuote = true
      i++
      continue
    }

    if (ch === delimiter) {
      row.push(field)
      field = ""
      i++
      continue
    }

    if (ch === "\r") {
      // CR or CRLF — treat as row separator
      row.push(field)
      field = ""
      rows.push(row)
      row = []
      if (text[i + 1] === "\n") i++
      i++
      continue
    }

    if (ch === "\n") {
      row.push(field)
      field = ""
      rows.push(row)
      row = []
      i++
      continue
    }

    field += ch
    i++
  }

  // Flush final field/row
  if (field || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

// ─── header detection ────────────────────────────────────────────────────────

const KNOWN_SOURCE_HEADERS = new Set([
  "source", "src", "original", "sourcetext", "source_text",
  "en", "english", "from",
])
const KNOWN_TARGET_HEADERS = new Set([
  "target", "tgt", "translation", "translated", "targettext", "target_text",
  "to",
])
const KNOWN_ID_HEADERS = new Set([
  "id", "key", "identifier", "ref", "unit", "tuid", "segment id", "segid",
])
const KNOWN_CONTEXT_HEADERS = new Set([
  "context", "note", "notes", "comment", "comments", "description", "translator note",
])

/**
 * Return true if the first row looks like a header row.
 * We only consider a row a header when at least one cell is a recognised
 * bilingual field keyword. A pure positional fallback would misclassify
 * real data rows (e.g. "Hello,Hola") as headers.
 */
function isHeaderRow(row: string[]): boolean {
  if (row.length < 2) return false
  const lc = row.map((c) => c.trim().toLowerCase())
  return lc.some(
    (c) => KNOWN_SOURCE_HEADERS.has(c) || KNOWN_TARGET_HEADERS.has(c) || KNOWN_ID_HEADERS.has(c),
  )
}

// ─── column layout detection ─────────────────────────────────────────────────

interface ColLayout {
  idCol: number | null
  srcCol: number
  tgtCol: number
  /** Column index for context/note (4th column). null = not available. */
  ctxCol: number | null
}

/**
 * Determine column layout from the first content row (after any header).
 * Returns null if we can't determine a valid layout (< 2 columns).
 */
function detectLayout(headerRow: string[] | null, contentRow: string[]): ColLayout | null {
  if (contentRow.length < 2) return null

  if (headerRow) {
    // Use header names to assign columns
    const lc = headerRow.map((c) => c.trim().toLowerCase())
    let idCol: number | null = null
    let srcCol = -1
    let tgtCol = -1
    let ctxCol: number | null = null
    for (let i = 0; i < lc.length; i++) {
      if (KNOWN_ID_HEADERS.has(lc[i]) && idCol === null) idCol = i
      else if (KNOWN_SOURCE_HEADERS.has(lc[i]) && srcCol === -1) srcCol = i
      else if (KNOWN_TARGET_HEADERS.has(lc[i]) && tgtCol === -1) tgtCol = i
      else if (KNOWN_CONTEXT_HEADERS.has(lc[i]) && ctxCol === null) ctxCol = i
    }
    // If we found both source and target, use them
    if (srcCol !== -1 && tgtCol !== -1) return { idCol, srcCol, tgtCol, ctxCol }
    // If only one or neither recognized, fall through to positional
  }

  // Positional heuristic
  if (contentRow.length === 2) {
    return { idCol: null, srcCol: 0, tgtCol: 1, ctxCol: null }
  }

  // 3+ columns: check if col[0] looks like an id (no spaces, short)
  const firstCell = contentRow[0].trim()
  const looksLikeId =
    firstCell.length <= 64 &&
    !/\s/.test(firstCell) &&
    !/[^\x20-\x7e]/.test(firstCell)

  if (looksLikeId) {
    // col[0]=id, col[1]=source, col[2]=target, col[3]=context (if present)
    const ctxCol = contentRow.length >= 4 ? 3 : null
    return { idCol: 0, srcCol: 1, tgtCol: 2, ctxCol }
  }
  // col[0]=source, col[1]=target, col[2]=context (if present)
  const ctxCol = contentRow.length >= 3 ? 2 : null
  return { idCol: null, srcCol: 0, tgtCol: 1, ctxCol }
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Parse a CSV or TSV bilingual file.
 * Auto-detects delimiter, optional header row, and optional leading id column.
 */
export function parseCsvBilingual(text: string): TranslatableString[] {
  const rows = parseCsvRows(text)
  if (rows.length === 0) return []

  // Filter out completely-empty rows
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim().length > 0))
  if (nonEmpty.length === 0) return []

  // Header detection
  let headerRow: string[] | null = null
  let dataRows = nonEmpty
  if (isHeaderRow(nonEmpty[0])) {
    headerRow = nonEmpty[0]
    dataRows = nonEmpty.slice(1)
  }

  if (dataRows.length === 0) return []

  const layout = detectLayout(headerRow, dataRows[0])
  if (!layout) return []

  const results: TranslatableString[] = []
  let rowIndex = 0

  for (const row of dataRows) {
    rowIndex++
    const original = (row[layout.srcCol] ?? "").trim()
    const translated = (row[layout.tgtCol] ?? "").trim()
    const idValue = layout.idCol !== null ? (row[layout.idCol] ?? "").trim() : ""
    const ctxNote = layout.ctxCol !== null ? (row[layout.ctxCol] ?? "").trim() : ""

    if (!original) continue

    // Build context: id (or row number) optionally annotated with the context/note column
    const baseContext = idValue || `Row ${rowIndex}`
    const context = ctxNote ? `${baseContext} — ${ctxNote}` : baseContext

    results.push({
      id: uuid(),
      original,
      translated,
      context,
      group: idValue || `row-${rowIndex}`,
      type: "text",
    })
  }

  return results
}
