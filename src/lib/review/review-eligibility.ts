export interface BulkReviewCandidate {
  translated: string
  targetEventId?: string | null
  aiDrafted?: boolean
}

export interface BulkReviewPolicy {
  /**
   * The org's `allowBulkValidateAiDrafts` setting. Off unless the org turns it
   * on, which keeps the rule below.
   */
  allowAiDrafts?: boolean
}

/**
 * Bulk validation is reserved for human-authored or human-edited text.
 *
 * An untouched AI draft must be reviewed explicitly, one cell at a time. A
 * human target commit clears `aiDrafted` in the server projection, after which
 * the cell is eligible for the convenience bulk action again.
 *
 * An org may lift that rule for its own projects (`allowAiDrafts`, Sam
 * 2026-10-01): some teams review the drafts in place and then sign a whole
 * passage off at once. Off by default. The rest still holds either way — a
 * blank or uncommitted cell is never bulk-validated.
 */
export function isBulkValidationEligible(
  cell: BulkReviewCandidate,
  policy: BulkReviewPolicy = {},
): boolean {
  return Boolean(
    cell.translated.trim() &&
    cell.targetEventId &&
    (!cell.aiDrafted || policy.allowAiDrafts === true),
  )
}
