/**
 * AQU-990 — client-side guard for the bulk-import per-cell text ceiling.
 *
 * The sync worker's `POST /import` route rejects any cell whose `value` /
 * `valueHtml` (or a paired target's) exceeds `MAX_CELL_TEXT_BYTES`. Before this
 * module the browser importer had no idea, so a large document (the reported
 * case: an IDML with a multi-hundred-KB frontmatter story) was parsed, chunked
 * and uploaded in full before failing on a bare
 * `Upload failed (HTTP 413): {"error":"cell text exceeds size limit"}` — with
 * nothing to say *which* cell was at fault.
 *
 * Checking here fails before the first chunk leaves the browser and names the
 * offending cells. Format-specific partitioning (see `partitionOversizedIdmlUnits`
 * in `@/lib/parsers/idml`) runs earlier and removes the common case; whatever
 * survives that reaches the user as an actionable message rather than a 413.
 */

import { MAX_CELL_TEXT_BYTES, utf8ByteLength } from "../../../shared/import-contract"
import type { BulkImportCell, TargetCommit } from "../sync/bulk-import"
import { t } from "../i18n/standalone"

/** Which side of a cell blew the ceiling — the user-facing message says so,
 *  because a huge source and a huge pre-filled target need different fixes. */
export type OversizedCellSide = "source" | "target"

export interface OversizedImportCell {
  cellId: string
  side: OversizedCellSide
  /** UTF-8 size of the largest offending field on this cell/side. */
  bytes: number
  /** Human-facing anchor: canonical ref when the cell has one, else its
   *  1-based position in the file. */
  label: string
}

/** How many offenders to name before the message falls back to a count. */
const MAX_LISTED = 3

function labelFor(cell: BulkImportCell, index: number): string {
  return cell.canonicalRef?.trim() || `#${index + 1}`
}

function largestFieldBytes(value: string | undefined, valueHtml: string | undefined): number {
  return Math.max(
    value === undefined ? 0 : utf8ByteLength(value),
    valueHtml === undefined ? 0 : utf8ByteLength(valueHtml),
  )
}

/**
 * Every cell (and paired target) whose text exceeds the server ceiling, in
 * file order. Empty means the payload will clear the route's size checks.
 */
export function findOversizedImportCells(
  cells: readonly BulkImportCell[],
  targets: readonly TargetCommit[] = [],
): OversizedImportCell[] {
  const labelByCellId = new Map<string, string>()
  const oversized: OversizedImportCell[] = []

  cells.forEach((cell, index) => {
    const label = labelFor(cell, index)
    labelByCellId.set(cell.cellId, label)
    const bytes = largestFieldBytes(cell.value, cell.valueHtml)
    if (bytes > MAX_CELL_TEXT_BYTES) {
      oversized.push({ cellId: cell.cellId, side: "source", bytes, label })
    }
  })

  for (const target of targets) {
    const bytes = largestFieldBytes(target.value, target.valueHtml)
    if (bytes > MAX_CELL_TEXT_BYTES) {
      oversized.push({
        cellId: target.cellId,
        side: "target",
        bytes,
        label: labelByCellId.get(target.cellId) ?? target.cellId,
      })
    }
  }

  return oversized
}

/**
 * Fail the import before uploading when any cell is oversized, naming the file,
 * the first few offending cells and the ceiling they broke. No-op when every
 * cell fits.
 */
export function assertImportCellsWithinSizeLimit(
  fileName: string,
  cells: readonly BulkImportCell[],
  targets: readonly TargetCommit[] = [],
): void {
  const oversized = findOversizedImportCells(cells, targets)
  if (oversized.length === 0) return

  const listed = oversized.slice(0, MAX_LISTED).map((entry) => t(
    entry.side === "target"
      ? "importExport.errors.oversizedCellTarget"
      : "importExport.errors.oversizedCellSource",
    { label: entry.label, size: formatKB(entry.bytes) },
  ))
  const remaining = oversized.length - listed.length
  if (remaining > 0) {
    listed.push(t("importExport.errors.oversizedCellsMore", { count: remaining }))
  }

  throw new Error(t("importExport.errors.oversizedCells", {
    fileName,
    count: oversized.length,
    maxSize: formatKB(MAX_CELL_TEXT_BYTES),
    cells: listed.join("; "),
  }))
}

/** Sizes here are always cell-scale, so KB with no decimals reads best and
 *  needs no locale-aware unit selection. */
function formatKB(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}
