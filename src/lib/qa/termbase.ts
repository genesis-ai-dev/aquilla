// Termbase spreadsheet import (Matecat-parity run).
//
// Matecat accepts glossaries as spreadsheets with ≥2 locale columns plus
// optional Forbidden/Definition/Notes columns
// (https://guides.matecat.com/termbase-file-format). This maps those rows
// onto Aquilla's existing Concept terminology model
// (src/lib/terminology/types.ts) so imported termbases flow into the same
// rule-engine surface the in-app glossary uses.
import { v4 as uuid } from "uuid"
import type { Concept, TermRendering } from "@/lib/terminology/types"

export interface TermbaseParseResult {
  concepts: Concept[]
  /** 1-based row numbers skipped (empty source or no usable columns). */
  skippedRows: number[]
}

const TRUE_RE = /^(true|yes|1|x)$/i

/**
 * Parse spreadsheet rows (from parseCsvRows or parseXlsxToSheets) into
 * Concepts. Column layout, per the Matecat template:
 *   - an optional leading "forbidden" column (header contains "forbidden",
 *     or unlabeled first column whose data rows are all blank/TRUE-ish),
 *   - then source-locale column, then target-locale column,
 *   - optional trailing "definition"/"notes" column appended to Concept.notes.
 * A header row is detected when the first row contains no TRUE-ish flag and
 * is referenced for column naming; otherwise columns are positional.
 */
export function parseTermbaseRows(rows: string[][], nowIso?: string): TermbaseParseResult {
  const skippedRows: number[] = []
  if (rows.length === 0) return { concepts: [], skippedRows }

  const header = rows[0].map((h) => (h ?? "").trim().toLowerCase())
  const looksLikeHeader = header.some((h) => /source|target|term|forbidden|definition|notes|[a-z]{2}(-[a-z]{2})?/.test(h)) &&
    !header.some((h) => TRUE_RE.test(h))
  const dataStart = looksLikeHeader ? 1 : 0

  let forbiddenCol = -1
  let notesCol = -1
  if (looksLikeHeader) {
    forbiddenCol = header.findIndex((h) => h.includes("forbidden") || h.includes("blacklist"))
    notesCol = header.findIndex((h) => h.includes("definition") || h.includes("notes"))
  }
  // source/target = first two columns that are neither forbidden nor notes
  const termCols: number[] = []
  const width = Math.max(...rows.map((r) => r.length))
  for (let c = 0; c < width && termCols.length < 2; c++) {
    if (c !== forbiddenCol && c !== notesCol) termCols.push(c)
  }
  if (termCols.length < 2) return { concepts: [], skippedRows: rows.map((_, i) => i + 1) }
  const [srcCol, tgtCol] = termCols

  const created = nowIso ?? new Date().toISOString()
  const byTerm = new Map<string, Concept>()
  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r]
    const source = (row[srcCol] ?? "").trim()
    const target = (row[tgtCol] ?? "").trim()
    if (!source || !target) {
      skippedRows.push(r + 1)
      continue
    }
    const forbidden = forbiddenCol >= 0 && TRUE_RE.test((row[forbiddenCol] ?? "").trim())
    const rendering: TermRendering = { rendering: target, status: forbidden ? "forbidden" : "preferred" }
    const key = source.toLowerCase()
    const existing = byTerm.get(key)
    if (existing) {
      existing.renderings.push(rendering)
    } else {
      byTerm.set(key, {
        id: uuid(),
        sourceTerm: source,
        renderings: [rendering],
        ...(notesCol >= 0 && (row[notesCol] ?? "").trim() ? { notes: (row[notesCol] ?? "").trim() } : {}),
        status: "active",
        createdAt: created,
      })
    }
  }
  return { concepts: [...byTerm.values()], skippedRows }
}
