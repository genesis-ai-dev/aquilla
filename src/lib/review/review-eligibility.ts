export interface BulkReviewCandidate {
  translated: string
  targetEventId?: string | null
  aiDrafted?: boolean
}

/**
 * Bulk validation is reserved for human-authored or human-edited text.
 *
 * An untouched AI draft must be reviewed explicitly, one cell at a time. A
 * human target commit clears `aiDrafted` in the server projection, after which
 * the cell is eligible for the convenience bulk action again.
 */
export function isBulkValidationEligible(cell: BulkReviewCandidate): boolean {
  return Boolean(
    cell.translated.trim() &&
    cell.targetEventId &&
    !cell.aiDrafted,
  )
}
