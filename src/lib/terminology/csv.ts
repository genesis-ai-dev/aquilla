/**
 * CSV import / export for Concept[].
 *
 * Column convention (one row per rendering, grouped by sourceTerm):
 *   sourceTerm, rendering, status, notes
 *
 * - `status` is "preferred" | "admitted" | "forbidden" (case-insensitive on import).
 * - `notes` is the concept-level note; repeated on every row of the same concept
 *   for symmetry — on export the note appears on every row; on import only the
 *   first occurrence per sourceTerm wins (subsequent duplicates are ignored).
 * - Rows with no rendering are silently skipped (degenerate input).
 * - sourceTerm matching is case-insensitive for grouping purposes; the first
 *   occurrence's casing is used as the canonical sourceTerm.
 * - Concepts imported here receive status "active" and a generated id+createdAt.
 *   Callers may override status after import.
 */

import { v4 as uuid } from "uuid"
import type { Concept, TermRendering, RenderingStatus } from "./types"

const HEADER = "sourceTerm,rendering,status,notes"

/** Export Concept[] to a CSV string with the documented column layout. */
export function exportConceptsCsv(concepts: Concept[]): string {
  const lines: string[] = [HEADER]
  for (const c of concepts) {
    if (c.renderings.length === 0) {
      // Concept with no renderings — emit a placeholder row so it survives round-trip.
      lines.push(`${csvCell(c.sourceTerm)},,${csvCell(c.notes ?? "")}`)
      continue
    }
    for (const r of c.renderings) {
      lines.push(
        [csvCell(c.sourceTerm), csvCell(r.rendering), r.status, csvCell(c.notes ?? "")].join(","),
      )
    }
  }
  return lines.join("\n")
}

/** Parse a CSV string into Concept[]. Tolerates Windows line endings. */
export function importConceptsCsv(text: string): Concept[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  // Skip header row (case-insensitive check).
  const start = lines[0]?.toLowerCase().startsWith("sourceterm") ? 1 : 0

  // Accumulate renderings per sourceTerm (case-insensitive key → canonical term).
  const order: string[] = [] // insertion order for stable output
  const byKey = new Map<
    string,
    { sourceTerm: string; notes: string; renderings: TermRendering[] }
  >()

  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols = parseCsvRow(line)
    const sourceTerm = cols[0]?.trim() ?? ""
    const rendering = cols[1]?.trim() ?? ""
    const statusRaw = cols[2]?.trim().toLowerCase() ?? "preferred"
    const notes = cols[3]?.trim() ?? ""
    if (!sourceTerm) continue

    const key = sourceTerm.toLowerCase()
    if (!byKey.has(key)) {
      order.push(key)
      byKey.set(key, { sourceTerm, notes, renderings: [] })
    }
    const entry = byKey.get(key)!
    // Update notes only from first occurrence — subsequent rows are ignored.
    if (notes && !entry.notes) entry.notes = notes
    if (rendering) {
      const status = isRenderingStatus(statusRaw) ? statusRaw : "preferred"
      entry.renderings.push({ rendering, status })
    }
  }

  const now = new Date().toISOString()
  return order.map((key) => {
    const e = byKey.get(key)!
    return {
      id: uuid(),
      sourceTerm: e.sourceTerm,
      renderings: e.renderings,
      notes: e.notes || undefined,
      status: "active" as const,
      createdAt: now,
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  // Quote if contains comma, quote, or newline.
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function isRenderingStatus(s: string): s is RenderingStatus {
  return s === "preferred" || s === "admitted" || s === "forbidden"
}

/**
 * Parse a single CSV row, respecting quoted fields with escaped quotes (RFC 4180).
 */
function parseCsvRow(line: string): string[] {
  const cols: string[] = []
  let i = 0
  while (i <= line.length) {
    if (i === line.length) { cols.push(""); break }
    if (line[i] === '"') {
      // Quoted field.
      let field = ""
      i++ // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 2 }
          else { i++; break } // closing quote
        } else {
          field += line[i++]
        }
      }
      cols.push(field)
      if (line[i] === ",") i++
    } else {
      const end = line.indexOf(",", i)
      if (end === -1) { cols.push(line.slice(i)); break }
      cols.push(line.slice(i, end))
      i = end + 1
    }
  }
  return cols
}
