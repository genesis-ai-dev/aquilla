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
 * exactly `tag` — the same match the projection's lane_id lookup uses, so a
 * false here is exactly the write that would resolve a NULL `lane_id`.
 * A named tag has to exist or the write is a 422.
 *
 * AQU-1884: `''` — the omitted tag, the former default lane — is no longer
 * waved through. It resolves only when the project HAS a `''` lane row
 * (a legacy/migrated project), or when this very write mints the bridge:
 * `ensureBlankTargetBridgeStmt`'s `NOT EXISTS` inserts the bridge only for a
 * project with no target lane at all, so a bridging kind on a project that
 * already has tagged lanes gains nothing and used to fail the whole batch as a
 * 500 ("DB batch failed"). `bridges` is {@link createsBlankLaneBridge} for the
 * event's kind — false for the validation kinds, which never mint a lane.
 *
 * Shares the per-request lane list with the archived-lane check.
 */
export async function targetLaneRowExists(
  db: AquillaDb,
  projectId: string,
  tag: string,
  cache: RequestCache,
  bridges = false,
): Promise<boolean> {
  const lanes = await rowsFor(db, projectId, cache)
  if (lanes.some((lane) => lane.legacyTag === tag)) return true
  return tag === '' && bridges && lanes.length === 0
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
