/**
 * AQU-316: Spreadsheet parser for CSV and XLSX files.
 *
 * CSV: re-exports parseCsvRows from csv-bilingual (no dependency).
 * XLSX: XLSX is a ZIP archive; JSZip reads its central directory and handles
 * the ZIP variants emitted by Excel, LibreOffice, and Google Sheets. We then
 * extract the shared strings table + each sheet's XML and return rows as
 * string[][].
 *
 * Encrypted XLSXs are not supported (they require an Office encryption
 * container rather than a normal Open Packaging Convention ZIP).
 *
 * Column mapping is done by the caller (ColumnMappingPanel) using the
 * SpreadsheetSheet interface returned here.
 */

import JSZip from "jszip"
import { parseCsvRows } from "./csv-bilingual"
import { assertSafeArchiveInputSize, assertSafeZipArchive } from "./zip-safety"
export { parseCsvRows }

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
 * The XML reader handles the common case (string/number cells, shared strings
 * table, and cached formula values).
 * Complex features (formulas that depend on external data, pivot tables,
 * encrypted workbooks) are not supported.
 */
export async function parseXlsxToSheets(buffer: ArrayBuffer): Promise<SpreadsheetSheet[]> {
  assertSafeArchiveInputSize(buffer.byteLength, "XLSX workbook")
  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(buffer)
  } catch (error) {
    throw new Error(`Could not read XLSX archive: ${error instanceof Error ? error.message : String(error)}`)
  }
  assertSafeZipArchive(archive, "XLSX workbook")

  const readEntry = async (path: string): Promise<string | null> => {
    const entry = archive.file(path)
    return entry ? entry.async("string") : null
  }

  // Shared strings table (optional — some XLSXs inline all strings)
  let sharedStrings: string[] = []
  const ssXml = await readEntry("xl/sharedStrings.xml")
  if (ssXml) sharedStrings = parseSharedStrings(ssXml)

  // Workbook: get sheet names + rIds in order
  const wbXml = await readEntry("xl/workbook.xml")
  const sheetMeta: { name: string; rId: string }[] = []
  if (wbXml) {
    const sheetRegex = /<sheet\s[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/?>/g
    let m: RegExpExecArray | null
    while ((m = sheetRegex.exec(wbXml)) !== null) {
      sheetMeta.push({ name: decodeXmlEntities(m[1]), rId: m[2] })
    }
  }

  // Workbook relationships: rId → sheet path
  const relsXml = await readEntry("xl/_rels/workbook.xml.rels")
  const rIdToPath = new Map<string, string>()
  if (relsXml) {
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
    const sheetXml = await readEntry(path)
    if (!sheetXml) continue
    const rows = parseSheetXml(sheetXml, sharedStrings)
    sheets.push({ name: meta.name, rows })
  }

  // Fallback: if no workbook relationships, enumerate sheet files directly
  if (sheets.length === 0) {
    let i = 1
    while (true) {
      const sheetXml = await readEntry(`xl/worksheets/sheet${i}.xml`)
      if (!sheetXml) break
      const rows = parseSheetXml(sheetXml, sharedStrings)
      sheets.push({ name: `Sheet${i}`, rows })
      i++
    }
  }

  if (sheets.length === 0) {
    throw new Error("The XLSX workbook does not contain any readable worksheets.")
  }
  return sheets
}

// ─── Column mapping types ────────────────────────────────────────────────────

/**
 * AQU-316: User-configured column mapping for a spreadsheet sheet.
 * `null` = "not mapped / ignore".
 */
export interface ColumnMapping {
  sourceCol: number | null
  targetCol: number | null
  /** Cell label / ref column (e.g. "GEN 1:1"). */
  labelCol: number | null
  /** Optional semantic unit type (verse, heading, cue, paragraph, etc.). */
  typeCol?: number | null
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
  type?: string
  /** One-based row in the source sheet (including its header, when present). */
  sourceRow?: number
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

  for (const [rowIndex, row] of dataRows.entries()) {
    const original = mapping.sourceCol !== null ? (row[mapping.sourceCol] ?? "").trim() : ""
    if (!original) continue

    const translated = mapping.targetCol !== null ? (row[mapping.targetCol] ?? "").trim() : ""
    const ref = mapping.labelCol !== null ? (row[mapping.labelCol] ?? "").trim() : ""
    const type = mapping.typeCol !== null && mapping.typeCol !== undefined
      ? (row[mapping.typeCol] ?? "").trim() || undefined
      : undefined
    const castName = mapping.castCol !== null ? (row[mapping.castCol] ?? "").trim() || undefined : undefined
    const start = mapping.startCol !== null ? parseTimestamp(row[mapping.startCol] ?? "") : undefined
    const end = mapping.endCol !== null ? parseTimestamp(row[mapping.endCol] ?? "") : undefined

    results.push({
      id: uuid(),
      original,
      translated,
      ref,
      type,
      sourceRow: rowIndex + (hasHeader ? 2 : 1),
      castName,
      start,
      end,
    })
  }

  return results
}

/**
 * Convert MappedRow[] → TranslatableString[] (used to feed into the standard
 * bulkUploadSource pipeline).
 */
export function mappedRowsToStrings(rows: MappedRow[]): TranslatableString[] {
  const strings = rows.map((r, i) => {
    const explicitType = r.type?.trim().toLowerCase()
    const scriptureRef = /^([1-3]?[A-Z]{2,3})\s+(\d+):(\d+[a-z]?(?:-\d+[a-z]?)?)$/i.exec(r.ref)
    const canonicalRef = scriptureRef
      ? `${scriptureRef[1].toUpperCase()} ${Number(scriptureRef[2])}:${scriptureRef[3]}`
      : undefined
    const type: TranslatableString["type"] = /^(heading|header|title|section|chapter)$/.test(explicitType ?? "")
      ? "heading"
      : explicitType === "verse" || (!explicitType && canonicalRef)
        ? "verse"
        : explicitType === "list"
          ? "list"
          : /^(blockquote|quote)$/.test(explicitType ?? "")
            ? "blockquote"
            : explicitType === "paratext"
              ? "paratext"
              : explicitType === "cue" || (!explicitType && r.start !== undefined && r.end !== undefined)
                ? "cue"
                : "text"
    const scriptureScope = canonicalRef?.slice(0, canonicalRef.indexOf(":"))
    const structuralReference = scriptureScope && (type === "heading" || type === "paratext")
      ? `${scriptureScope}:${type === "heading" ? "h" : "p"}:${r.sourceRow ?? i + 1}`
      : undefined
    const identityReference = structuralReference ?? (type === "verse" ? canonicalRef : undefined)

    return {
      id: r.id,
      original: r.original,
      translated: r.translated,
      context: r.ref || `Row ${i + 1}`,
      group: identityReference ?? (r.ref || `row-${i + 1}`),
      ...(identityReference
        ? { globalReferences: [identityReference], ...(scriptureScope ? { section: scriptureScope } : {}) }
        : {}),
      ...(r.start !== undefined && r.end !== undefined ? { start: r.start, end: r.end } : {}),
      ...(r.castName ? { speaker: r.castName } : {}),
      type,
      ...(type === "text" ? { paragraphStart: true } : {}),
      metadata: {
        aquillaRecipe: {
          recipeId: "builtin:spreadsheet-mapping",
          record: r.sourceRow ?? i + 1,
          field: "source",
        },
        ...(r.ref && !canonicalRef ? { spreadsheetLabel: r.ref } : {}),
      },
    }
  })

  return strings.map((string, index) => {
    if ((string.type !== "heading" && string.type !== "paratext") || string.section) return string
    const nextScope = strings.slice(index + 1).find((candidate) => candidate.section)?.section
    const previousScope = strings.slice(0, index).reverse().find((candidate) => candidate.section)?.section
    const scriptureScope = nextScope ?? previousScope
    if (!scriptureScope || !/^[1-3]?[A-Z]{2,3}\s+\d+$/i.test(scriptureScope)) return string
    const occurrence = rows[index]?.sourceRow ?? index + 1
    const structuralReference = `${scriptureScope}:${string.type === "heading" ? "h" : "p"}:${occurrence}`
    return {
      ...string,
      section: scriptureScope,
      group: structuralReference,
      globalReferences: [structuralReference],
    }
  })
}

// ─── AQU-439: Cast-name / camera-angle splitter ──────────────────────────────

/**
 * Come and See encodes camera angle inside the character-label string:
 *   "Mary Magdalene   (on)"   →  voice = "Mary Magdalene", angle = "on"
 *   "Peter  (mixed)"          →  voice = "Peter",          angle = "mixed"
 *   "Narrator"                →  voice = "Narrator",       angle = undefined
 *
 * The trailing `(…)` group is always separated from the name by one or more
 * spaces. Unknown angle synonyms are passed through as-is so they can be
 * stored and rounded to the nearest known CameraState by the caller.
 *
 * Synonym mapping (normalises common variants to CameraState literals):
 *   on    → "on"
 *   off   → "off"
 *   mixed → "mixed"
 *   group → "mixed"   (a group shot → mixed lip-sync constraint)
 *   (any other text) → returned verbatim; the caller maps to "mixed" as fallback
 */
export interface SplitCastName {
  /** The voice/character name with the angle suffix stripped. */
  voice: string
  /** Normalised CameraState, or undefined when no angle was present. */
  cameraState: "on" | "mixed" | "off" | undefined
}

const CAMERA_STATE_SYNONYM_MAP: Record<string, "on" | "mixed" | "off"> = {
  on: "on",
  off: "off",
  mixed: "mixed",
  group: "mixed",
}

/**
 * Split a raw cast_name string that may contain a trailing `(angle)` group.
 * Returns `{ voice, cameraState }` — the voice is always trimmed.
 */
export function splitCastName(raw: string): SplitCastName {
  const trimmed = raw.trim()
  // Match trailing "(…)" optionally preceded by whitespace.
  // The regex requires at least one non-paren character inside the parens.
  const match = /^(.*?)\s+\(([^)]+)\)\s*$/.exec(trimmed)
  if (!match) {
    return { voice: trimmed, cameraState: undefined }
  }
  const voice = match[1].trim()
  const angleRaw = match[2].trim().toLowerCase()
  const cameraState = CAMERA_STATE_SYNONYM_MAP[angleRaw] ?? "mixed"
  return { voice, cameraState }
}

// ─── Cell-label template generation (AQU-314) ────────────────────────────────

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

// ─── Paired source+target import (AQU-315) ───────────────────────────────────

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
