// AQU-1902: the lane row the editor's target writes go to — or null while it
// cannot be named, in which case the editor stays read-only ("Loading
// languages…") rather than queuing a write that would be refused and lost.
//
// WHY READ-ONLY AND NOT A QUEUE. Until the lane rows load, the editor filters
// cells on the persisted lane TAG; for a reader with no stored choice that tag
// is `''`, so on a project whose lanes are all tagged every target cell shows
// blank. A queue that "flushes onto the right lane once lanes resolve" would
// then commit text typed against a blank cell, chained on a head the reader
// never saw, onto whichever lane opens first — overwriting that lane's real
// translation (or going stale against it). Blocking cannot misroute or lose
// anything, and the window is one settings round trip.
//
// A reader who HAS opened the project before has the lane id stored (AQU-1613),
// read off a real lane row: the editor already shows that lane's cells, so
// writes to it are stamped with that id at once — and keep working offline,
// where the rows may never arrive.

import { useEffect, useMemo } from "react"
import { readPersistedLaneChoice } from "@/lib/lanes/active-lane-choice"
import { resolveTargetLaneRef, type TargetLaneRef, type TargetLaneRow } from "@/lib/lanes/target-lane-ref"
import { setProjectLaneHint } from "@/lib/sync/project-target-lanes"

export interface ActiveTargetLaneInput {
  /** Target lane rows, or null before the settings response carrying them. */
  laneRows: readonly TargetLaneRow[] | null
  /** True once the settings GET has answered (with or without lane rows). */
  settingsFetched: boolean
  /** The editor's active lane tag. */
  activeLane: string
  /** The persisted lane choice for this project. */
  stored: { laneId: string | null; legacyTag: string | null } | null
}

/** Pure core of {@link useActiveTargetLane}. */
export function activeTargetLaneFor(input: ActiveTargetLaneInput): TargetLaneRef | null {
  const { laneRows, settingsFetched, activeLane, stored } = input
  if (laneRows) {
    const resolved = resolveTargetLaneRef(laneRows, { targetLang: activeLane })
    return resolved.ok ? resolved.lane : null
  }
  // A server that answered without lane rows predates them (AQU-1418): its
  // writes are tag-only, as they always were.
  if (settingsFetched) return { targetLang: activeLane, laneId: null }
  if (stored?.laneId && (stored.legacyTag ?? "") === activeLane) {
    return { targetLang: activeLane, laneId: stored.laneId }
  }
  return null
}

export function useActiveTargetLane(
  projectId: string | undefined,
  laneRows: readonly TargetLaneRow[] | null,
  settingsFetched: boolean,
  activeLane: string,
): TargetLaneRef | null {
  const active = useMemo(
    () =>
      activeTargetLaneFor({
        laneRows,
        settingsFetched,
        activeLane,
        // Re-read when the lane changes: setActiveLane persists the new choice.
        stored: projectId ? readPersistedLaneChoice(projectId) : null,
      }),
    [projectId, laneRows, settingsFetched, activeLane],
  )
  const hintId = active?.laneId ?? null
  const hintTag = active?.targetLang ?? ""
  useEffect(() => {
    if (!projectId) return
    setProjectLaneHint(projectId, hintId ? { laneId: hintId, targetLang: hintTag } : null)
  }, [projectId, hintId, hintTag])
  return active
}
