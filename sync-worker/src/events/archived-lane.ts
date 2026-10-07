// AQU-1462: load the rows and settings an archived-lane refusal needs.
// Memoized on the request cache so a batch pays for the lane list once.

import { listProjectLanes } from '../../../db/shared/lanes'
import type { AquillaDb } from '../../../db/shim/postgres'
import {
  archivedLaneReason,
  archivedTagsFromSettings,
  type ArchiveLaneRow,
} from '../../../src/lib/lanes/archived-lane'
import { laneDisplayName } from '../../../src/lib/lanes/lane-display'
import type { RequestCache } from './request-cache'

const rowsByCache = new WeakMap<RequestCache, Map<string, Promise<ArchiveLaneRow[]>>>()

async function loadRows(db: AquillaDb, projectId: string): Promise<ArchiveLaneRow[]> {
  const lanes = await listProjectLanes(db, projectId)
  return lanes
    .filter((lane) => lane.role === 'target')
    .map((lane) => ({
      id: lane.id,
      // AQU-1592: the refusal message names the lane the way the screen does —
      // the name when one was set, else the language.
      name: laneDisplayName(lane),
      legacyTag: lane.legacyTag,
      archivedAt: lane.archivedAt,
    }))
}

function rowsFor(db: AquillaDb, projectId: string, cache: RequestCache): Promise<ArchiveLaneRow[]> {
  let byProject = rowsByCache.get(cache)
  if (!byProject) {
    byProject = new Map()
    rowsByCache.set(cache, byProject)
  }
  let pending = byProject.get(projectId)
  if (!pending) {
    pending = loadRows(db, projectId)
    byProject.set(projectId, pending)
  }
  return pending
}

/**
 * AQU-1612: the project's target lane rows, memoized per request. The lane
 * resolver needs them to turn an event's `laneId` into the lane's frozen tag;
 * sharing the archived-lane list means an id-bearing batch pays for the lane
 * list once, not once per event.
 */
export function targetLaneRowsFor(
  db: AquillaDb,
  projectId: string,
  cache: RequestCache,
): Promise<ArchiveLaneRow[]> {
  return rowsFor(db, projectId, cache)
}

/**
 * AQU-1532: true when the project has a target lane row whose legacy tag is
 * exactly `tag` — the same match the projection's lane_id lookup uses.
 * `''` is not refused as missing: a bare project has no such lane yet, and
 * the cell-write batch creates that bridge before resolving lane_id
 * (AQU-1594). A named tag still has to exist or the write is a 422.
 * Shares the per-request lane list with the archived-lane check.
 */
export async function targetLaneRowExists(
  db: AquillaDb,
  projectId: string,
  tag: string,
  cache: RequestCache,
): Promise<boolean> {
  if (tag === '') return true
  const lanes = await rowsFor(db, projectId, cache)
  return lanes.some((lane) => lane.legacyTag === tag)
}

/**
 * Stable 403 reason, or null.
 *
 * AQU-1600: a `tag` of `''` is the former default lane — an ordinary lane that
 * can be archived — so it is checked like any other rather than waved through.
 * A project with no `''` lane row simply has no match and is not refused.
 *
 * `visibleLaneIds` null means the caller may know every lane. A set hides the
 * archived name from a caller who may not know that lane exists.
 */
export async function refusalForArchivedLane(
  db: AquillaDb,
  projectId: string,
  tag: string,
  cache: RequestCache,
  visibleLaneIds: ReadonlySet<string> | null = null,
): Promise<string | null> {
  const [settings, lanes] = await Promise.all([
    cache.projectSettings(projectId),
    rowsFor(db, projectId, cache),
  ])
  return archivedLaneReason({
    tag,
    lanes,
    archivedTags: archivedTagsFromSettings(settings),
    visibleLaneIds,
  })
}
