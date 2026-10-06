// AQU-490: who a bulk text validation actually applies to.
//
// EXTRACTED BECAUSE THE TWO BULK PATHS HAD DRIFTED. The selection toolbar
// skipped cells outside the caller's assignment and cells they had already
// signed off; the three-dot "Validate all" did neither, so a scoped member
// using the menu emitted a guaranteed 403 for every cell outside their scope
// and a redundant second vote for every cell already theirs. The projection
// folds the redundant ones away and the server rejects the rest, so the only
// visible symptom was a batch that took longer than it should.
//
// One predicate, used by both, is what stops that happening again.
import { isBulkValidationEligible } from "@/lib/review/review-eligibility"
import { isOwnTextEdit } from "@/lib/review/text-validation-policy"
import { isInMemberScope, type MemberScope } from "@/lib/sync/member-scopes"

export interface BulkValidatableCell {
  fileId: string
  activeValidators?: string[]
  /** Who wrote the line's current text in the active lane (see `isOwnTextEdit`). */
  lastEditor?: string | null
}

export interface BulkValidatePolicy {
  /** The project's "Allow self-validation". Only `false` withholds anything. */
  allowSelfValidation?: boolean
}

export function isBulkValidatableByMe(
  cell: BulkValidatableCell & Parameters<typeof isBulkValidationEligible>[0],
  username: string,
  myScopes: MemberScope[],
  activeLane: string,
  policy: BulkValidatePolicy = {},
): boolean {
  if (!isBulkValidationEligible(cell)) return false
  // AQU-633: a scoped member's validate on an out-of-scope cell is a
  // guaranteed 403. The server stays authoritative; this only keeps the
  // doomed event out of the outbox.
  if (!isInMemberScope(myScopes, cell.fileId, activeLane)) return false
  // Already mine. A second vote is not wrong — the projection is keyed on
  // (cell, user) and folds it away — but it is a wasted round trip, and it
  // makes the count the UI promised disagree with the work actually done.
  if (cell.activeValidators?.includes(username)) return false
  // AQU-1571: the reader's own latest change, on a project that wants someone
  // else to sign it off. The server refuses every one of these, and each
  // refusal used to come back as a line in the red "failed" banner.
  if (isOwnTextEdit(cell, username, policy.allowSelfValidation)) return false
  return true
}
