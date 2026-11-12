/**
 * Wire shape for GET /api/v1/projects/:projectId/concepts/:conceptId/occurrences.
 *
 * The sync-worker builds this object and the SPA parses it. Kept free of `@/`
 * imports so a worker test can run a real response through this parser.
 */

export interface TermOccurrenceWire {
  cellId: string
  fileId: string
  original: string
  translated: string
  translatedHtml: string | null
  context: string
  sourceEventId: string
  targetEventId: string | null
}

/** A surface the matcher hit, counted across the whole scan. */
export interface TermFormTally {
  surface: string
  count: number
  excluded: boolean
}

export interface TermOccurrencePage {
  occurrences: TermOccurrenceWire[]
  /** Confirmed matches in the scan, not the length of this page. */
  total: number
  offset: number
  limit: number
  /**
   * False when the scan stopped at the row cap. `total` is then a lower
   * bound, and the page must not be shown as a complete count.
   */
  scanComplete: boolean
  enforced: number
  infringed: number
  /** Distinct source surfaces from the scan, not from this page alone. */
  forms: TermFormTally[]
}

function isWire(value: unknown): value is TermOccurrenceWire {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    typeof row.cellId === "string" &&
    typeof row.fileId === "string" &&
    typeof row.original === "string" &&
    typeof row.translated === "string" &&
    (row.translatedHtml === null || typeof row.translatedHtml === "string") &&
    typeof row.context === "string" &&
    typeof row.sourceEventId === "string" &&
    (row.targetEventId === null || typeof row.targetEventId === "string")
  )
}

/** Accept a response body that is exactly a term-occurrence page. */
export function parseTermOccurrencePage(body: unknown): TermOccurrencePage | null {
  if (!body || typeof body !== "object") return null
  const page = body as Record<string, unknown>
  if (!Array.isArray(page.occurrences) || !page.occurrences.every(isWire)) return null
  if (
    typeof page.total !== "number" ||
    typeof page.offset !== "number" ||
    typeof page.limit !== "number" ||
    typeof page.scanComplete !== "boolean" ||
    typeof page.enforced !== "number" ||
    typeof page.infringed !== "number" ||
    !Array.isArray(page.forms) ||
    !page.forms.every(isForm)
  ) {
    return null
  }
  return {
    occurrences: page.occurrences,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    scanComplete: page.scanComplete,
    enforced: page.enforced,
    infringed: page.infringed,
    forms: page.forms,
  }
}

function isForm(value: unknown): value is TermFormTally {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return typeof row.surface === "string" && typeof row.count === "number" && typeof row.excluded === "boolean"
}
