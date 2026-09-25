// AQU-894: which files in the open project are the current user's own work.
//
// The sidebar's job is to make "mine" obvious in a project with many files —
// names like "01" / "O1" don't, and until now an assignment changed nothing
// about how a file row looked. This module is the one place that decides what
// "mine" means, so the row, its tests, and anything else that grows an
// assignment-aware affordance later agree without reading each other's mind.
//
// It is deliberately a pure function over the inbox read the workspace already
// fires (`getMyAssignments`) — no extra request, and no roster data: a
// contributor may always see their OWN assignments, while the project-wide
// `assignments/units` read sits behind the org's roster + member-progress
// floors (both maintainer by default) and 403s for exactly the translator this
// is for.

import type { MyAssignment } from "@/lib/sync/assignments"

/**
 * The set of file ids the caller holds an open assignment on, in `projectId`.
 *
 * Prefers each assignment's `fileIds` (every file its cells touch) and falls
 * back to the single `fileId` when an older worker didn't send the array — an
 * under-count on a multi-file scope, which fails the safe way: a file that is
 * really yours looks un-dimmed like everyone else's, rather than a file that
 * isn't yours being presented as yours.
 */
export function assignedFileIds(
  assignments: readonly MyAssignment[],
  projectId: string,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const a of assignments) {
    if (a.projectId !== projectId) continue
    if (a.fileIds && a.fileIds.length > 0) {
      for (const id of a.fileIds) ids.add(id)
    } else if (a.fileId) {
      ids.add(a.fileId)
    }
  }
  return ids
}

/**
 * Whether the file list should de-emphasise the rows that aren't the caller's.
 *
 * FALSE WHEN THE CALLER HOLDS NOTHING, which is the whole no-assignments case:
 * teams that never assign — and a member of an assigning team who simply has
 * no open assignment — see an untouched file list rather than a project where
 * every row is greyed out and nothing says why. So the affordance switches
 * itself on for the person it helps and stays invisible for everyone else; it
 * needs no setting to be safe by default.
 */
export function shouldDimUnassigned(assigned: ReadonlySet<string>): boolean {
  return assigned.size > 0
}
