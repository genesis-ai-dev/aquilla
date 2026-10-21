// AQU-538 / AQU-1613: the editor's open target lane — the tag the cell list is
// filtered on and target writes are addressed to.
//
// Lifted out of ProjectWorkspace so the effects that move it can be driven in
// a test. The bug that moved it here lived in how two of them interleaved: a
// fallback that reset the lane to `''` on a render whose lane rows had gone
// missing, after a one-shot migration that never ran again — so the editor sat
// on "Loading languages…" with the rows loaded (AQU-1902's lock, held forever).

import { useCallback, useEffect, useRef, useState } from "react"
import {
  firstPositionLaneId,
  laneIdForTag,
  laneTagForId,
  readPersistedActiveLane,
  readPersistedLaneChoice,
  resolveStoredLaneId,
  writePersistedActiveLane,
  type LaneChoiceRow,
} from "@/lib/lanes/active-lane-choice"
import { resolveTargetLaneRef } from "@/lib/lanes/target-lane-ref"

export interface UseActiveLaneInput {
  projectId: string | undefined
  /** The project's target lane rows, or null while no settings response
   *  carrying them has reached the project record. */
  laneRows: readonly LaneChoiceRow[] | null
  /** The tags the lane switcher offers (`switcherLaneTags`). */
  availableLanes: readonly string[]
}

export interface ActiveLane {
  activeLane: string
  /** The reader's (or a deep link's) choice: opens the lane and persists it. */
  setActiveLane: (lane: string) => void
  /** The lane just set is an explicit choice for this project (a `?lane=` deep
   *  link): the stored-choice migration must not override it. */
  claimLaneChoice: () => void
}

const NO_ROWS: readonly LaneChoiceRow[] = []

export function useActiveLane({ projectId, laneRows: knownRows, availableLanes }: UseActiveLaneInput): ActiveLane {
  const laneRows = knownRows ?? NO_ROWS
  // Persisted per project; this tag is what the first paint filters on.
  const [activeLane, setActiveLaneState] = useState<string>(() =>
    projectId ? readPersistedActiveLane(projectId) : "",
  )
  // Reload the persisted lane when navigating between projects.
  useEffect(() => {
    setActiveLaneState(projectId ? readPersistedActiveLane(projectId) : "")
  }, [projectId])
  const setActiveLane = useCallback(
    (lane: string) => {
      setActiveLaneState(lane)
      // AQU-1613: persisted by lane id; the tag rides along as the hint the
      // next first paint needs before the lane rows arrive.
      if (projectId) writePersistedActiveLane(projectId, laneIdForTag(lane, laneRows), lane)
    },
    [projectId, laneRows],
  )
  // Keeps the open lane one the project has. Three cases:
  //
  //  - Rows not known: leave the lane alone. Nothing says it is gone, and the
  //    rows can be missing for a render after they were shown (the workspace's
  //    IDB merge can land a copy of the record from before the settings
  //    response). Resetting here moved a reader off their lane on every load
  //    and, mid-load, onto `''`.
  //  - Rows known, none of them a target lane: `''` is the lane a first write
  //    mints (AQU-1594); a registry tag stays while the registry offers it.
  //  - Rows known: the open lane must name one of them (the AQU-1902 rule), or
  //    the editor stays on "Loading languages…" for good. On the first pass for
  //    a project it is the AQU-1613 migration: the stored choice, resolved id
  //    first, and the key rewritten. On any later pass a lane that names no
  //    row — removed, or `''` on a project with no `''` lane — re-resolves the
  //    stored choice, else the lane in first position (never the former
  //    default `''`, which AQU-1600 makes archivable).
  const storedLaneMigratedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!projectId || knownRows === null) return
    if (knownRows.length === 0) {
      if (activeLane && !availableLanes.includes(activeLane) && availableLanes.includes("")) {
        setActiveLaneState("")
      }
      return
    }
    const migrating = storedLaneMigratedRef.current !== projectId
    if (!migrating && resolveTargetLaneRef(knownRows, { targetLang: activeLane }).ok) return
    storedLaneMigratedRef.current = projectId
    const stored = readPersistedLaneChoice(projectId)
    const laneId = resolveStoredLaneId(stored, knownRows) ?? firstPositionLaneId(knownRows)
    const lane = laneTagForId(laneId, knownRows)
    setActiveLaneState(lane)
    // Rewrite the key only for a choice that was actually stored — a reader who
    // has never switched lanes keeps an empty slot and follows first position,
    // rather than having today's first lane pinned behind their back.
    const hadStoredChoice = stored.laneId !== null || stored.legacyTag !== null
    if (migrating && hadStoredChoice && laneId) writePersistedActiveLane(projectId, laneId, lane)
  }, [projectId, knownRows, availableLanes, activeLane])
  const claimLaneChoice = useCallback(() => {
    // An explicit lane in the URL is the reader's current choice, so it also
    // wins over whatever the stored-choice migration would have opened.
    if (projectId) storedLaneMigratedRef.current = projectId
  }, [projectId])
  return { activeLane, setActiveLane, claimLaneChoice }
}
