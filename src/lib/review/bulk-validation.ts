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
import { isInMemberScope, type MemberScope } from "@/lib/sync/member-scopes"

export interface BulkValidatableCell {
  fileId: string
  activeValidators?: string[]
}

export function isBulkValidatableByMe(
  cell: BulkValidatableCell & Parameters<typeof isBulkValidationEligible>[0],
  username: string,
  myScopes: MemberScope[],
  activeLane: string,
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
  return true
}
