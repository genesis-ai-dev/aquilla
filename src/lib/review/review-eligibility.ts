export interface BulkReviewCandidate {
  translated: string
  targetEventId?: string | null
  /**
   * `cells.ai_drafted` — provenance for the reader (the "AI draft · review
   * required" badge). Declared here and deliberately NOT read: a guard that
   * omitted the field instead would let the AQU-1703 exclusion be restored with
   * every test still green, because no fixture could mark a line as
   * machine-drafted. Callers pass whole cells, which carry it.
   */
  aiDrafted?: boolean
}

/**
 * Bulk validation covers every line that HAS a committed translation.
 *
 * AQU-1703: it used to exclude untouched AI drafts (`cells.ai_drafted`), with
 * an org switch to lift the rule. That exclusion was wrong, and wrong in a way
 * that read as a refusal: `ai_drafted` is cleared by a human *target commit*,
 * so eligibility tracked "has somebody retyped this line" rather than "is
 * there committed text to sign off". A reviewer's selection of five of a
 * colleague's AI-assisted translations was therefore reported back as "5 are
 * untouched AI drafts, reviewed one at a time" — and in a mixed selection only
 * the lines the reviewer had typed themselves were signed off, which is the
 * exact inverse of what review is for (AQU-1503 bounced on this).
 *
 * Validating another person's work — machine-drafted or not — is the whole job.
 * The acting user puts their own name on each line through the same
 * `cell.validate` the gutter control emits, the server accepts it and clears
 * `ai_drafted` as part of the projection, and the project's per-run cap
 * (AQU-586) bounds how much one gesture covers.
 *
 * What still holds: a blank or uncommitted cell is never bulk-validated. Who
 * MAY validate is a separate question, asked by `isBulkValidatableByMe` (scope,
 * already-mine, self-validation) and enforced by the server.
 *
 * The AI-draft guard remains on the external Agent API (AQU-1184,
 * `sync-worker/src/external/emit-events-engine.ts`): an agent laundering its
 * own output into validated text is a different act from a person signing it.
 */
export function isBulkValidationEligible(cell: BulkReviewCandidate): boolean {
  return Boolean(cell.translated.trim() && cell.targetEventId)
}
