// AQU-490: which TAKES a bulk audio action applies to, and which it withdraws.
//
// The audio twin of bulk-validation.ts, and extracted for the same reason that
// one was: the "which takes can I validate" rule was already written out twice,
// in the selection island and in the three-dot action, and adding a withdraw
// rule beside each would have made four copies of two rules. That file's own
// header records what drift cost last time.
//
// A TAKE, not a cell. Text validation asks about a cell because a cell holds
// one translation per lane; a line can hold a take per track, and each is
// signed off on its own.
import { isInMemberScope, type MemberScope } from "@/lib/sync/member-scopes"
import type { AudioValidationTake } from "@/components/cell/AudioValidationControl"

export interface BulkAudioCell {
  fileId: string
}

/**
 * Can this viewer still add their vote to this take?
 *
 * `canValidate` folds the project's role floor, its named-validator list and
 * the self-validation rule, all decided by `audioValidationTakes` before the
 * take reaches here.
 */
export function isBulkAudioValidatableByMe(
  cell: BulkAudioCell,
  take: AudioValidationTake,
  username: string,
  myScopes: MemberScope[],
  activeLane: string,
): boolean {
  if (!isInMemberScope(myScopes, cell.fileId, activeLane)) return false
  if (!take.canValidate) return false
  // A synthesized voice is the AI-draft analogue: it can be signed off, but
  // only deliberately and one at a time, never swept up by a bulk action.
  if (take.isGenerated) return false
  // Already mine — a second vote folds away server-side, but it would make the
  // count the button promised disagree with the work it did.
  if (take.validators.includes(username)) return false
  return true
}

/**
 * Can this viewer withdraw a vote from this take? True when they have one.
 *
 * DELIBERATELY NOT GATED ON `canValidate`. That flag is false for a take you
 * recorded yourself on a project with self-validation off — which is right for
 * casting a vote and wrong for withdrawing one. If such a vote exists (the
 * setting was changed after it was cast, say), gating here would strand it:
 * unremovable from every surface that offers a bulk withdraw. Generated voices
 * are likewise removable even though they are never bulk-validated, for the
 * same reason — a vote that can be given by hand must be removable in bulk.
 */
export function isBulkAudioUnvalidatableByMe(
  cell: BulkAudioCell,
  take: AudioValidationTake,
  username: string,
  myScopes: MemberScope[],
  activeLane: string,
): boolean {
  if (!isInMemberScope(myScopes, cell.fileId, activeLane)) return false
  return take.validators.includes(username)
}
