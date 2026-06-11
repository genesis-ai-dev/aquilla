/**
 * FRO-316: Spreadsheet parser for CSV and XLSX files.
 *
 * CSV: re-exports parseCsvRows from csv-bilingual (no dependency).
 * XLSX: zero-dependency approach — XLSX is a ZIP archive; we unzip using the
 * native `DecompressionStream` (available in modern browsers and Node ≥ 18).
 * We extract the shared strings table + each sheet's XML and return rows as
 * string[][].
 *
 * NOTE: DecompressionStream only supports deflate/deflate-raw; XLSX files may
 * also use "STORED" (no compression) entries — both are handled. Encrypted
 * XLSXs are not supported (they'd require a different ZIP format entirely).
 *
 * Column mapping is done by the caller (ColumnMappingPanel) using the
 * SpreadsheetSheet interface returned here.
 */

import { parseCsvRows } from "./csv-bilingual"
export { parseCsvRows }

// ─── ZIP / XLSX parser (no dependency) ────────────────────────────────────────

/**
 * Minimal ZIP central-directory entry needed to extract one file.
 */
interface ZipEntry {
  name: string
  /** Raw compressed bytes (may be uncompressed if method=0). */
  data: Uint8Array
  /** Compression method: 0=stored, 8=deflate. */
  method: number
}

/**
 * Parse a ZIP archive (ArrayBuffer) and return the entries by filename.
 * Only reads the local file headers (start-of-archive); does not use the
 * central directory — sufficient for well-formed XLSX files.
 */
function parseZipEntries(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const entries = new Map<string, ZipEntry>()
  let offset = 0

  while (offset + 30 <= bytes.length) {
    const sig = view.getUint32(offset, true)
    // Local file header signature: 0x04034b50
    if (sig !== 0x04034b50) break

    const method = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const filenameLen = view.getUint16(offset + 26, true)
    const extraLen = view.getUint16(offset + 28, true)

    const nameBytes = bytes.slice(offset + 30, offset + 30 + filenameLen)
    const name = new TextDecoder().decode(nameBytes)

    const dataStart = offset + 30 + filenameLen + extraLen
    const data = bytes.slice(dataStart, dataStart + compressedSize)

    entries.set(name, { name, data, method })
    offset = dataStart + compressedSize
  }

  return entries
}

/**
 * Decompress a deflate-compressed Uint8Array using DecompressionStream.
 * Falls back gracefully when DecompressionStream is unavailable (returns
 * the raw bytes — callers will get garbled text, but won't crash the import).
 */
async function decompress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    // Node <18 or old browser — best effort: return raw bytes (will fail XML parse).
    return data
  }
  const ds = new DecompressionStream("deflate-raw")
  const writer = ds.writable.getWriter()
  const reader = ds.readable.getReader()
  // Cast to satisfy the strict ArrayBuffer (not SharedArrayBuffer) constraint
  writer.write(data.buffer as ArrayBuffer)
  writer.close()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

/**
 * Decode a ZIP entry to a UTF-8 string.
 */
async function entryText(entry: ZipEntry): Promise<string> {
  const bytes = entry.method === 8 ? await decompress(entry.data) : entry.data
  return new TextDecoder("utf-8").decode(bytes)
}

// ─── XLSX sheet XML parser ────────────────────────────────────────────────────

/**
 * Extract all <si> (shared string) values from the xl/sharedStrings.xml text.
 * Returns an array indexed by shared-string id.
 */
function parseSharedStrings(xml: string): string[] {
  const strs: string[] = []
  // Each <si>…</si> block = one string. Collect all <t> text values within it.
  const siRegex = /<si>([\s\S]*?)<\/si>/g
  let siMatch: RegExpExecArray | null
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const block = siMatch[1]
    const tRegex = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g
    let tMatch: RegExpExecArray | null
    let value = ""
    while ((tMatch = tRegex.exec(block)) !== null) {
      value += tMatch[1]
    }
    // Decode common XML entities
    strs.push(decodeXmlEntities(value))
  }
  return strs
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/**
 * Parse a single xl/worksheets/sheetN.xml into rows of strings.
 * Each <row> contains <c> cells; shared strings have t="s", inline strings
 * t="inlineStr", numbers have no t attr (or t="n").
 */
function parseSheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = []
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowXml = rowMatch[1]
    const cells: { col: number; value: string }[] = []
    const cellRegex = /<c\s([^>]*)>([\s\S]*?)<\/c>/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
      const attrs = cellMatch[1]
      const inner = cellMatch[2]

      // Get cell ref (e.g. "A1", "B3") to determine column index
      const rMatch = /r="([A-Z]+)(\d+)"/.exec(attrs)
      const colStr = rMatch?.[1] ?? ""
      const col = colLetterToIndex(colStr)

      // Determine type
      const tMatch = /t="([^"]*)"/.exec(attrs)
      const cellType = tMatch?.[1] ?? ""

      let value = ""
      if (cellType === "s") {
        // Shared string
        const vMatch = /<v>(\d+)<\/v>/.exec(inner)
        if (vMatch) {
          const idx = parseInt(vMatch[1], 10)
          value = sharedStrings[idx] ?? ""
        }
      } else if (cellType === "inlineStr") {
        const tMatch2 = /<t>([^<]*)<\/t>/.exec(inner)
        value = decodeXmlEntities(tMatch2?.[1] ?? "")
      } else {
        // Number, boolean, or formula result
        const vMatch = /<v>([^<]*)<\/v>/.exec(inner)
        value = vMatch?.[1] ?? ""
        // For formulas, also check <is><t> inline string override
        const isMatch = /<is><t>([^<]*)<\/t><\/is>/.exec(inner)
        if (isMatch) value = decodeXmlEntities(isMatch[1])
      }

      cells.push({ col, value })
    }

    if (cells.length === 0) continue

    // Build a dense row (fill gaps with empty strings)
    const maxCol = Math.max(...cells.map((c) => c.col))
    const row: string[] = new Array(maxCol + 1).fill("")
    for (const c of cells) row[c.col] = c.value
    rows.push(row)
  }
  return rows
}

/** Convert A→0, B→1, Z→25, AA→26, etc. */
function colLetterToIndex(col: string): number {
  let n = 0
  for (const ch of col) {
    n = n * 26 + (ch.charCodeAt(0) - 64)
  }
  return n - 1
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SpreadsheetSheet {
  /** Sheet name (e.g. "Sheet1", or the Excel sheet tab name). */
  name: string
  /** All rows including any header row. rows[0] is the first row. */
  rows: string[][]
}

/**
 * Parse a CSV string into a single sheet.
 */
export function parseCsvToSheet(text: string, fileName: string): SpreadsheetSheet {
  const rows = parseCsvRows(text)
  return { name: fileName, rows }
}

/**
 * Parse an XLSX ArrayBuffer into one sheet per worksheet tab.
 * Returns the sheets in workbook order. Each sheet's `rows` includes headers.
 *
 * NOTE: This is a dependency-free implementation using the native ZIP + XML
 * APIs. It handles the common case (string/number cells, shared strings table).
 * Complex features (formulas that depend on external data, pivot tables,
 * encrypted workbooks) are not supported.
 */
export async function parseXlsxToSheets(buffer: ArrayBuffer): Promise<SpreadsheetSheet[]> {
  const entries = parseZipEntries(buffer)

  // Shared strings table (optional — some XLSXs inline all strings)
  let sharedStrings: string[] = []
  const ssEntry = entries.get("xl/sharedStrings.xml")
  if (ssEntry) {
    const ssXml = await entryText(ssEntry)
    sharedStrings = parseSharedStrings(ssXml)
  }

  // Workbook: get sheet names + rIds in order
  const wbEntry = entries.get("xl/workbook.xml")
  const sheetMeta: { name: string; rId: string }[] = []
  if (wbEntry) {
    const wbXml = await entryText(wbEntry)
    const sheetRegex = /<sheet\s[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/?>/g
    let m: RegExpExecArray | null
    while ((m = sheetRegex.exec(wbXml)) !== null) {
      sheetMeta.push({ name: decodeXmlEntities(m[1]), rId: m[2] })
    }
  }

  // Workbook relationships: rId → sheet path
  const relsEntry = entries.get("xl/_rels/workbook.xml.rels")
  const rIdToPath = new Map<string, string>()
  if (relsEntry) {
    const relsXml = await entryText(relsEntry)
    const relRegex = /<Relationship\s[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/?>/g
    let m: RegExpExecArray | null
    while ((m = relRegex.exec(relsXml)) !== null) {
      // Target is relative to xl/; may or may not have "worksheets/" prefix
      const target = m[2].startsWith("/") ? m[2].slice(1) : `xl/${m[2]}`
      rIdToPath.set(m[1], target)
    }
  }

  // Parse each sheet
  const sheets: SpreadsheetSheet[] = []
  for (const meta of sheetMeta) {
    const path = rIdToPath.get(meta.rId)
    if (!path) continue
    const sheetEntry = entries.get(path)
    if (!sheetEntry) continue
    const sheetXml = await entryText(sheetEntry)
    const rows = parseSheetXml(sheetXml, sharedStrings)
    sheets.push({ name: meta.name, rows })
  }

  // Fallback: if no workbook relationships, enumerate sheet files directly
  if (sheets.length === 0) {
    let i = 1
    while (true) {
      const entry = entries.get(`xl/worksheets/sheet${i}.xml`)
      if (!entry) break
      const sheetXml = await entryText(entry)
      const rows = parseSheetXml(sheetXml, sharedStrings)
      sheets.push({ name: `Sheet${i}`, rows })
      i++
    }
  }

  return sheets
}

// ─── Column mapping types ────────────────────────────────────────────────────

/**
 * FRO-316: User-configured column mapping for a spreadsheet sheet.
 * `null` = "not mapped / ignore".
 */
export interface ColumnMapping {
  sourceCol: number | null
  targetCol: number | null
  /** Cell label / ref column (e.g. "GEN 1:1"). */
  labelCol: number | null
  /** Cast / character name column. */
  castCol: number | null
  /** Start timestamp column (numeric seconds or HH:MM:SS). */
  startCol: number | null
  /** End timestamp column. */
  endCol: number | null
}

/**
 * Apply a ColumnMapping to a sheet's rows (skipping the header row if present)
 * and produce TranslatableString-compatible objects.
 */
import type { TranslatableString } from "./types"
import { v4 as uuid } from "uuid"

export interface MappedRow {
  id: string
  original: string
  translated: string
  /** Canonical ref / cell label (e.g. "GEN 1:1") */
  ref: string
  castName: string | undefined
  start: number | undefined
  end: number | undefined
}

/**
 * Convert a timestamp string (HH:MM:SS, HH:MM:SS.mmm, or bare number of seconds)
 * to seconds. Returns undefined when unparseable.
 */
function parseTimestamp(s: string): number | undefined {
  const trimmed = s.trim()
  if (!trimmed) return undefined
  // Bare number
  const n = Number(trimmed)
  if (!isNaN(n)) return n
  // HH:MM:SS or HH:MM:SS.mmm
  const parts = trimmed.split(":")
  if (parts.length === 3) {
    const [h, m, sec] = parts.map(Number)
    if (!isNaN(h) && !isNaN(m) && !isNaN(sec)) return h * 3600 + m * 60 + sec
  }
  if (parts.length === 2) {
    const [m, sec] = parts.map(Number)
    if (!isNaN(m) && !isNaN(sec)) return m * 60 + sec
  }
  return undefined
}

/**
 * Apply mapping to rows (header row is rows[0] if mapping was derived from it;
 * callers pass `hasHeader` to skip it).
 */
export function applyColumnMapping(
  rows: string[][],
  mapping: ColumnMapping,
  hasHeader: boolean,
): MappedRow[] {
  const dataRows = hasHeader ? rows.slice(1) : rows
  const results: MappedRow[] = []

  for (const row of dataRows) {
    const original = mapping.sourceCol !== null ? (row[mapping.sourceCol] ?? "").trim() : ""
    if (!original) continue

    const translated = mapping.targetCol !== null ? (row[mapping.targetCol] ?? "").trim() : ""
    const ref = mapping.labelCol !== null ? (row[mapping.labelCol] ?? "").trim() : ""
    const castName = mapping.castCol !== null ? (row[mapping.castCol] ?? "").trim() || undefined : undefined
    const start = mapping.startCol !== null ? parseTimestamp(row[mapping.startCol] ?? "") : undefined
    const end = mapping.endCol !== null ? parseTimestamp(row[mapping.endCol] ?? "") : undefined

    results.push({ id: uuid(), original, translated, ref, castName, start, end })
  }

  return results
}

/**
 * Convert MappedRow[] → TranslatableString[] (used to feed into the standard
 * bulkUploadSource pipeline).
 */
export function mappedRowsToStrings(rows: MappedRow[]): TranslatableString[] {
  return rows.map((r, i) => ({
    id: r.id,
    original: r.original,
    translated: r.translated,
    context: r.ref || `Row ${i + 1}`,
    group: r.ref || `row-${i + 1}`,
    ...(r.start !== undefined && r.end !== undefined ? { start: r.start, end: r.end } : {}),
    ...(r.castName ? { speaker: r.castName } : {}),
    type: "text" as const,
  }))
}

// ─── Cell-label template generation (FRO-314) ────────────────────────────────

/**
 * Generate a downloadable CSV template for cell-label / cast import.
 * The template has one row per source cell ref from the project.
 * The PM fills in the "cast_name" column and re-imports.
 *
 * Returns a CSV string with a BOM so Excel opens it in UTF-8 correctly.
 */
export function generateLabelTemplate(refs: string[]): string {
  const BOM = "﻿"
  const header = "ref,cast_name,note"
  const rows = refs.map((r) => `"${r.replace(/"/g, '""')}",,`)
  return BOM + [header, ...rows].join("\r\n") + "\r\n"
}

// ─── Paired source+target import (FRO-315) ───────────────────────────────────

/** Minimal source cell descriptor for matching (mirrors SourceCellRef from import.ts). */
export interface MatchableSourceCell {
  cellId: string
  fileId: string
  targetEventId?: string
  sourceEventId?: string
  translated: string
  canonicalRef?: string | null
}

/** One matched cell result (mirrors EBibleMatchedCell from import.ts). */
export interface MatchedCell {
  cellId: string
  fileId: string
  incomingText: string
  currentText: string
  hasConflict: boolean
  parentId: string
  ref: string
}

/** Match result (mirrors EBibleMatchResult from import.ts). */
export interface PairedMatchResult {
  matched: MatchedCell[]
  orphans: { ref: string; text: string }[]
  unmatchedSourceCount: number
}

/**
 * Match rows from a paired spreadsheet (both source + target columns mapped)
 * against existing source cells by canonical ref. Returns the same shape as
 * EBibleMatchResult so the caller can reuse the conflict-resolution UI.
 */
export function matchPairedRowsToSourceCells(
  mappedRows: MappedRow[],
  sourceCells: MatchableSourceCell[],
): PairedMatchResult {
  // Build lookup by canonicalRef → source cell (first wins on dup)
  const byRef = new Map<string, MatchableSourceCell>()
  for (const cell of sourceCells) {
    if (cell.canonicalRef && !byRef.has(cell.canonicalRef)) {
      byRef.set(cell.canonicalRef, cell)
    }
  }

  const matched: MatchedCell[] = []
  const orphans: { ref: string; text: string }[] = []
  const matchedRefs = new Set<string>()

  for (const row of mappedRows) {
    const cell = row.ref ? byRef.get(row.ref) : undefined
    if (!cell) {
      if (row.ref) orphans.push({ ref: row.ref, text: row.translated })
      continue
    }
    matchedRefs.add(row.ref)
    const currentText = cell.translated ?? ""
    const parentId = cell.targetEventId ?? cell.sourceEventId ?? ""
    matched.push({
      cellId: cell.cellId,
      fileId: cell.fileId,
      incomingText: row.translated,
      currentText,
      hasConflict: currentText.trim().length > 0,
      parentId,
      ref: row.ref,
    })
  }

  const unmatchedSourceCount = sourceCells.filter(
    (c) => c.canonicalRef && !matchedRefs.has(c.canonicalRef),
  ).length

  return { matched, orphans, unmatchedSourceCount }
}
