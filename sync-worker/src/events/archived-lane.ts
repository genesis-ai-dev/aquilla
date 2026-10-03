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
 * AQU-1532: true when the project has a target lane row whose legacy tag is
 * exactly `tag` — the same match the projection's lane_id lookup uses. The
 * default lane (`''`) always counts as present. Shares the per-request lane
 * list with the archived-lane check.
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
 * Stable 403 reason, or null. `tag` of `''` is the default lane and is never refused.
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
  if (tag === '') return null
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
