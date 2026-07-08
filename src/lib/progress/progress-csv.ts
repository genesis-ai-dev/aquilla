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
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function toCsvLine(fields: ReadonlyArray<string | number>): string {
  return fields.map((f) => escapeCsvField(String(f))).join(",")
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
