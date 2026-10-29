/**
 * AQU-1510: the assign forms' "already holds this" warning, as data.
 *
 * Reads every live assignment on each file the new one would touch (the plan
 * inspector's own read, `getUnitAssignments` with the whole-file section) and
 * keeps the ones that overlap. That read is gated on the org's member-progress
 * and roster floors, so a manager below them gets a 403 and no warning rather
 * than a look at assignments the org keeps from them.
 *
 * Fetched again whenever the set of files changes. The overview form passes no
 * files while it is collapsed, so opening it loads the assignments that exist
 * now — including one created a moment ago in this same form (AQU-2130). A
 * cache that lived for the whole mount hid that assignment until a reload.
 * Changing the assignee or the scope does not refetch; those only re-read the
 * rows already loaded for these files. A refusal or a network error is no
 * warning, never an error in the form. More than MAX_FILES skips the check.
 */

import { useEffect, useMemo, useState } from "react"
import { getUnitAssignments, type AssignmentKind, type UnitAssignment } from "@/lib/sync/assignments"
import { findAssignmentOverlap, type AssignmentOverlap, type OverlapScope } from "@/lib/sync/assignment-overlap"

/** More files than this (a whole Bible picked at once) skip the check. */
const MAX_FILES = 40

export interface FileOverlap {
  fileId: string
  overlap: AssignmentOverlap
}

export interface UseAssignmentOverlapArgs {
  jwt: string | null | undefined
  projectId: string
  /** The files the new assignment covers, each with the same scope. */
  fileIds: readonly string[]
  scope: OverlapScope | null
  assigneeUserId: number | null
  lane: string | null | undefined
  kind: AssignmentKind
}

export function useAssignmentOverlap({
  jwt,
  projectId,
  fileIds,
  scope,
  assigneeUserId,
  lane,
  kind,
}: UseAssignmentOverlapArgs): FileOverlap[] {
  const [byFile, setByFile] = useState<ReadonlyMap<string, readonly UnitAssignment[]>>(new Map())
  const wanted = useMemo(
    () => (scope && assigneeUserId != null && fileIds.length <= MAX_FILES ? [...new Set(fileIds)] : []),
    [scope, assigneeUserId, fileIds],
  )
  // The file ids, not the array identity. Empty while the form is closed, so
  // closing and opening the same file is a change and fetches again.
  const wantedKey = wanted.join("\n")

  useEffect(() => {
    if (!jwt || !wantedKey) return
    let cancelled = false
    const ids = wantedKey.split("\n")
    void Promise.all(
      ids.map((fileId) =>
        getUnitAssignments(jwt, projectId, fileId, "", "")
          .then((rows) => [fileId, rows] as const)
          // Refused or unreachable: no warning, never an error in the form.
          .catch(() => [fileId, [] as UnitAssignment[]] as const),
      ),
    ).then((entries) => {
      if (cancelled) return
      setByFile((prev) => {
        const next = new Map(prev)
        for (const [fileId, rows] of entries) next.set(fileId, rows)
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, wantedKey])

  return useMemo(() => {
    if (!scope || assigneeUserId == null) return []
    const found: FileOverlap[] = []
    for (const fileId of wanted) {
      const rows = byFile.get(fileId)
      if (!rows) continue
      const overlap = findAssignmentOverlap(rows, { assigneeUserId, lane, kind, scope })
      if (overlap) found.push({ fileId, overlap })
    }
    return found
  }, [wanted, byFile, scope, assigneeUserId, lane, kind])
}
