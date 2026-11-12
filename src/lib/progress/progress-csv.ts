// AQU-500: pure CSV serializer for the per-file progress breakdown table in
// ProjectOverview. Kept separate from the component so the RFC-4180 escaping
// logic (commas/quotes/newlines in file names) gets direct unit coverage
// without rendering React.

/** One row of the exported progress table — mirrors the columns visible on screen. */
export interface ProgressCsvRow {
  name: string
  filledCount: number
  approvedCount: number
  cellCount: number
  wordCount: number
}

const CSV_HEADER = ["File", "Filled", "Approved", "Total cells", "Word count"] as const

/**
 * RFC-4180 field escaping: a field is wrapped in double quotes (with any
 * embedded double quote doubled) whenever it contains a comma, double quote,
 * or newline (CR or LF) — the characters that would otherwise break the
 * column/row boundaries a spreadsheet parses on paste/import.
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * Join one row's fields into an RFC-4180 line. Exported so every CSV surface
 * in the app shares this escaping rather than re-deriving it — the AQU-1392
 * analysis report is the second caller.
 */
export function toCsvLine(fields: ReadonlyArray<string | number>): string {
  return fields.map((f) => escapeCsvField(String(f))).join(",")
}

/** RFC-4180 line ending, shared by every CSV surface. */
export const CSV_EOL = "\r\n"

/**
 * Leading characters a spreadsheet reads as the start of a formula rather than
 * as text. Tab and CR are included because Excel strips them before parsing the
 * cell, so `\t=cmd|'/c calc'!A0` still evaluates.
 */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * AQU-1281: neutralize spreadsheet formula injection. User-authored text that
 * starts with a formula lead is prefixed with a single quote, which every
 * spreadsheet treats as "the rest of this cell is text" — so a comment body
 * someone typed as `=HYPERLINK(...)` is read by the person who opens the export,
 * not executed by their spreadsheet.
 *
 * Separate from {@link escapeCsvField}: RFC-4180 quoting protects the *parser's*
 * column boundaries and does nothing about formulas (a quoted `"=1+1"` still
 * evaluates on import). Both are needed, in this order.
 */
export function neutralizeCsvFormula(value: string): string {
  return CSV_FORMULA_LEAD.test(value) ? `'${value}` : value
}

/**
 * {@link toCsvLine} with formula neutralization on every string field. Numbers
 * are passed through untouched — a negative number is not an injection, and
 * quoting it would turn a numeric column into text.
 *
 * Use this for any CSV whose cells carry user-authored text (comment bodies,
 * author labels, file names). The comments export (AQU-1958) is the first
 * caller; the plain {@link toCsvLine} surfaces predate AQU-1281 and are being
 * migrated under that ticket.
 */
export function toSafeCsvLine(fields: ReadonlyArray<string | number>): string {
  return fields
    .map((f) => (typeof f === "string" ? neutralizeCsvFormula(f) : String(f)))
    .map((f) => escapeCsvField(String(f)))
    .join(",")
}

/**
 * Serialize the visible per-file progress rows to a CSV string, header
 * included, CRLF line endings per RFC 4180. Row order is the caller's
 * responsibility — pass rows already sorted/filtered to match what's on
 * screen (see ProjectOverview's AQU-499 `sorted` array).
 */
export function progressRowsToCsv(rows: readonly ProgressCsvRow[]): string {
  const lines = [
    toCsvLine(CSV_HEADER),
    ...rows.map((r) => toCsvLine([r.name, r.filledCount, r.approvedCount, r.cellCount, r.wordCount])),
  ]
  return lines.join("\r\n")
}

/**
 * Sanitize a project name into a filesystem-safe CSV filename. Mirrors the
 * pattern already used for the deliverable bundle download
 * (`src/lib/sync/export-bundle.ts`) so downloaded filenames are consistent
 * across export surfaces.
 */
export function progressCsvFilename(projectName: string): string {
  const safe = projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return `${safe || "project"}-progress.csv`
}
