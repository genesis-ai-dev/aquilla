/**
 * CSV import / export for Concept[].
 *
 * Export uses the canonical column layout (one row per rendering, grouped by
 * sourceTerm):
 *
 *   sourceTerm, rendering, status, notes
 *
 * Import is deliberately more permissive (AQU-467). Partner word lists arrive
 * as whatever spreadsheet the team already maintains, so we adapt to their
 * columns rather than asking them to reshape the sheet:
 *
 * - **Delimiter sniffing.** Comma, tab, semicolon and pipe are all accepted —
 *   whichever splits the header row into the most columns wins.
 * - **Header-driven column mapping.** Headers are matched case-, space- and
 *   punctuation-insensitively against synonym sets, so `Source Term`,
 *   `source_lemma`, `Headword` and `English` all land as the source column
 *   (likewise for renderings / status / notes). This is also what makes the
 *   `source_lemma · target_lemma · target_status · definition` layout the
 *   import dialog advertises actually work.
 * - **Language-named target columns.** If a header names a source column but
 *   no recognizable rendering column (`English | Kilisusu`), the first
 *   otherwise-unmapped column after the source is read as the renderings.
 * - **Status-bearing rendering columns.** A sheet that splits renderings by
 *   status into separate columns (`Preferred`, `Suggested`, `Do not use`) is
 *   read with the status implied by each column's header — no `status` column
 *   required.
 * - **Multi-value cells.** A rendering cell holding `fe; creencia` yields two
 *   renderings (split on `;`, `|` and newlines).
 * - **Quoted multi-line fields.** Records are tokenized across newlines, so a
 *   note containing a line break no longer truncates the sheet.
 * - **Positional fallback.** With no recognizable header the original fixed
 *   layout (sourceTerm, rendering, status, notes) still applies and the first
 *   row is read as data — headerless files import exactly as they used to.
 *   A first row that merely starts with a source synonym (`word`, `key`, …)
 *   but carries a status value in the positional status slot is still data.
 *
 * Either way:
 * - `status` is "preferred" | "admitted" | "forbidden". Partner vocabulary
 *   ("required" / "suggested" / "avoid" / …) is normalized onto those three;
 *   anything unrecognized falls back to "preferred".
 * - `notes` is concept-level — the first non-empty note per sourceTerm wins.
 * - Rows with no rendering still contribute the concept, with no renderings.
 * - sourceTerm matching is case-insensitive for grouping purposes; the first
 *   occurrence's casing is used as the canonical sourceTerm.
 * - Concepts imported here receive status "active" and a generated id +
 *   createdAt, so they land importable and default-active. Callers may
 *   override status after import.
 */

import { v4 as uuid } from "uuid"
import type { Concept, TermRendering, RenderingStatus } from "./types"

const HEADER = "sourceTerm,rendering,status,notes"

/** Delimiters we sniff for, in preference order on a tie. */
const DELIMITERS = [",", "\t", ";", "|"] as const

/** Separators inside a single cell that split one column into several renderings. */
const MULTI_VALUE_SEPARATORS = [";", "|", "\n"] as const

/** Index of the status cell in the positional (headerless) layout. */
const POSITIONAL_STATUS_COLUMN = 2

/** Export Concept[] to a CSV string with the documented column layout. */
export function exportConceptsCsv(concepts: Concept[]): string {
  const lines: string[] = [HEADER]
  for (const c of concepts) {
    if (c.renderings.length === 0) {
      // Concept with no renderings — emit a placeholder row so it survives
      // round-trip. Both the rendering AND status cells are empty, so the note
      // stays in the notes column.
      lines.push([csvCell(c.sourceTerm), "", "", csvCell(c.notes ?? "")].join(","))
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

/**
 * Parse a delimited term list into Concept[]. Tolerates Windows line endings,
 * a UTF-8 BOM, arbitrary column names and non-comma delimiters — see the file
 * header for the full contract.
 */
export function importConceptsCsv(text: string): Concept[] {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const delimiter = sniffDelimiter(source.split("\n", 1)[0] ?? "")
  const rows = parseDelimited(source, delimiter)
  if (rows.length === 0) return []

  const layout = detectLayout(rows[0])
  const dataRows = layout ? rows.slice(1) : rows

  // Accumulate renderings per sourceTerm (case-insensitive key → canonical term).
  const order: string[] = [] // insertion order for stable output
  const byKey = new Map<
    string,
    { sourceTerm: string; notes: string; renderings: TermRendering[] }
  >()

  for (const cols of dataRows) {
    const cell = (index: number | undefined): string =>
      index === undefined ? "" : (cols[index] ?? "").trim()

    const sourceTerm = layout ? cell(layout.source) : cell(0)
    if (!sourceTerm) continue
    const notes = layout ? cell(layout.notes) : cell(3)

    const key = sourceTerm.toLowerCase()
    if (!byKey.has(key)) {
      order.push(key)
      byKey.set(key, { sourceTerm, notes: "", renderings: [] })
    }
    const entry = byKey.get(key)!
    // First non-empty note per concept wins; later rows are ignored.
    if (notes && !entry.notes) entry.notes = notes

    if (layout) {
      // An explicit status column applies only to columns whose own header
      // didn't already imply a status.
      const rowStatus = layout.status === undefined ? undefined : parseStatus(cell(layout.status))
      for (const col of layout.renderings) {
        const status = col.status ?? rowStatus ?? "preferred"
        for (const rendering of splitMultiValue(cell(col.index), delimiter)) {
          entry.renderings.push({ rendering, status })
        }
      }
    } else {
      // Positional fallback — one rendering per row, no multi-value splitting,
      // exactly as before header detection existed.
      const rendering = cell(1)
      if (rendering) entry.renderings.push({ rendering, status: parseStatus(cell(2)) })
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
// Header vocabulary
// ---------------------------------------------------------------------------

/** Column holding the source headword. */
const SOURCE_HEADERS = new Set([
  "sourceterm", "sourceterms", "source", "sourcelemma", "sourceword", "sourcetext",
  "sourcelanguage", "sourceheadword", "term", "terms", "headword", "lemma", "entry",
  "concept", "word", "key", "english", "keyterm", "keyterms", "keyword", "keywords",
  "biblicalterm", "biblicalterms", "keybiblicalterm", "keybiblicalterms",
])

/** Column holding a rendering, with the status taken from elsewhere. */
const RENDERING_HEADERS = new Set([
  "rendering", "renderings", "target", "targets", "targetterm", "targetterms",
  "targetlemma", "targettext", "targetword", "targetlanguage", "targetrendering",
  "targettranslation", "translation", "translations", "equivalent", "equivalents",
  "gloss",
])

/** Column holding renderings whose status the header itself declares. */
const IMPLIED_STATUS_HEADERS = new Map<string, RenderingStatus>([
  ["preferred", "preferred"], ["preferredrendering", "preferred"],
  ["preferredterm", "preferred"], ["preferredtranslation", "preferred"],
  ["preferredform", "preferred"], ["required", "preferred"],
  ["requiredrendering", "preferred"], ["requiredterm", "preferred"],
  ["approved", "preferred"], ["approvedterm", "preferred"],
  ["recommended", "preferred"], ["use", "preferred"], ["usethis", "preferred"],

  ["admitted", "admitted"], ["admittedrendering", "admitted"],
  ["suggested", "admitted"], ["suggestedrendering", "admitted"],
  ["suggestedterm", "admitted"], ["allowed", "admitted"], ["acceptable", "admitted"],
  ["alternate", "admitted"], ["alternates", "admitted"], ["alternative", "admitted"],
  ["alternatives", "admitted"], ["alternateterm", "admitted"],
  ["permitted", "admitted"], ["optional", "admitted"], ["secondary", "admitted"],

  ["forbidden", "forbidden"], ["forbiddenrendering", "forbidden"],
  ["forbiddenterm", "forbidden"], ["avoid", "forbidden"], ["avoidterm", "forbidden"],
  ["donotuse", "forbidden"], ["dontuse", "forbidden"], ["neveruse", "forbidden"],
  ["banned", "forbidden"], ["prohibited", "forbidden"], ["disallowed", "forbidden"],
  ["notallowed", "forbidden"], ["rejected", "forbidden"], ["deprecated", "forbidden"],
])

/** Column holding a per-row status value. */
const STATUS_HEADERS = new Set([
  "status", "targetstatus", "renderingstatus", "termstatus", "usage", "preference", "type",
])

/** Column holding the concept-level note. */
const NOTES_HEADERS = new Set([
  "notes", "note", "comment", "comments", "definition", "definitions", "description",
  "remarks", "explanation", "meaning",
])

/** Partner vocabulary for a status *value*, normalized onto RenderingStatus. */
const STATUS_VALUES = new Map<string, RenderingStatus>([
  ["preferred", "preferred"], ["prefer", "preferred"], ["required", "preferred"],
  ["require", "preferred"], ["primary", "preferred"], ["main", "preferred"],
  ["approved", "preferred"], ["approve", "preferred"], ["recommended", "preferred"],
  ["recommend", "preferred"], ["use", "preferred"], ["standard", "preferred"],

  ["admitted", "admitted"], ["admit", "admitted"], ["suggested", "admitted"],
  ["suggest", "admitted"], ["allowed", "admitted"], ["allow", "admitted"],
  ["acceptable", "admitted"], ["alternate", "admitted"], ["alternative", "admitted"],
  ["permitted", "admitted"], ["permit", "admitted"], ["optional", "admitted"],
  ["secondary", "admitted"],

  ["forbidden", "forbidden"], ["forbid", "forbidden"], ["avoid", "forbidden"],
  ["donotuse", "forbidden"], ["dontuse", "forbidden"], ["neveruse", "forbidden"],
  ["banned", "forbidden"], ["ban", "forbidden"], ["prohibited", "forbidden"],
  ["prohibit", "forbidden"], ["disallowed", "forbidden"], ["notallowed", "forbidden"],
  ["rejected", "forbidden"], ["reject", "forbidden"], ["deprecated", "forbidden"],
])

// ---------------------------------------------------------------------------
// Layout detection
// ---------------------------------------------------------------------------

interface RenderingColumn {
  index: number
  /** Set when the column header itself declares the status. */
  status?: RenderingStatus
}

interface Layout {
  source: number
  renderings: RenderingColumn[]
  status?: number
  notes?: number
}

/**
 * Map a header row onto column roles. Returns null when the row carries no
 * recognizable source column — the caller then treats it as data and falls
 * back to the fixed positional layout.
 */
function detectLayout(header: string[]): Layout | null {
  let source: number | undefined
  let status: number | undefined
  let notes: number | undefined
  const renderings: RenderingColumn[] = []
  const unmapped: number[] = []

  header.forEach((raw, index) => {
    const key = normalizeHeader(raw)
    if (!key) {
      unmapped.push(index)
      return
    }
    if (source === undefined && SOURCE_HEADERS.has(key)) {
      source = index
      return
    }
    const implied = IMPLIED_STATUS_HEADERS.get(key)
    if (implied) {
      renderings.push({ index, status: implied })
      return
    }
    if (RENDERING_HEADERS.has(key)) {
      renderings.push({ index })
      return
    }
    if (status === undefined && STATUS_HEADERS.has(key)) {
      status = index
      return
    }
    if (notes === undefined && NOTES_HEADERS.has(key)) {
      notes = index
      return
    }
    unmapped.push(index)
  })

  if (source === undefined) return null

  // A headerless legacy row whose first term happens to be a source synonym
  // (`word,palabra,preferred,`) must not be mistaken for a header. What gives
  // it away: the positional status slot holds a status VALUE, where a real
  // header would name the role (`status`). So when nothing beyond the source
  // column is named — a lone status word in that slot is a value, not a column
  // name — read the row as data.
  const namedBeyondSource =
    status !== undefined ||
    notes !== undefined ||
    renderings.some((col) => col.index !== POSITIONAL_STATUS_COLUMN || col.status === undefined)
  if (!namedBeyondSource && isCanonicalStatus(header[POSITIONAL_STATUS_COLUMN] ?? "")) return null

  // A sheet that names its target column by language (`English | Kilisusu`)
  // has no header word we can recognize — read the first unmapped column after
  // the source as the renderings rather than dropping them on the floor.
  if (renderings.length === 0) {
    const fallback = unmapped.find((index) => index > source!)
    if (fallback !== undefined) renderings.push({ index: fallback })
  }

  return { source, renderings, status, notes }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  // Quote if contains comma, quote, or newline.
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** Lowercase and strip separators so `Do not use` and `do_not_use` both match. */
function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

function parseStatus(raw: string): RenderingStatus {
  return STATUS_VALUES.get(normalizeHeader(raw)) ?? "preferred"
}

/** True for the three values our own export writes into the positional status slot. */
function isCanonicalStatus(raw: string): boolean {
  const key = normalizeHeader(raw)
  return key === "preferred" || key === "admitted" || key === "forbidden"
}

/** Pick the delimiter that splits the header line into the most columns. */
function sniffDelimiter(headerLine: string): string {
  let best: string = DELIMITERS[0]
  let bestCount = 0
  for (const candidate of DELIMITERS) {
    const count = countUnquoted(headerLine, candidate)
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

function countUnquoted(line: string, char: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') i++
      else inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && line[i] === char) count++
  }
  return count
}

/**
 * Tokenize the whole document into rows, honouring RFC 4180 quoting — a quoted
 * field may contain the delimiter, doubled quotes, and newlines. Rows whose
 * cells are all blank are dropped.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false

  const endRow = () => {
    row.push(field)
    field = ""
    if (row.some((cell) => cell.trim() !== "")) rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
        continue
      }
      field += ch
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ""
      continue
    }
    if (ch === "\n") {
      endRow()
      continue
    }
    field += ch
  }
  endRow()

  return rows
}

/** Split one cell into several renderings on `;`, `|` or a newline. */
function splitMultiValue(value: string, delimiter: string): string[] {
  let parts = [value]
  for (const separator of MULTI_VALUE_SEPARATORS) {
    if (separator === delimiter) continue
    parts = parts.flatMap((part) => part.split(separator))
  }
  return parts.map((part) => part.trim()).filter(Boolean)
}
