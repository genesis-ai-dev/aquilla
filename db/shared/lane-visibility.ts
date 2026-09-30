// Shared grant lookup for the lane read wall.
//
// The auth worker and the sync worker both have to turn "this person, this
// project" into the lane ids they may see. The rules live in
// src/lib/lanes/read-wall.ts. This file is only the queries.

import {
  READ_WALL_MAINTAINER,
  filterSettingsToVisibleLanes,
  labelsForGrantedLanes,
  laneReadWallEnabled,
  visibleLaneTags,
  type LaneGrant,
  type LaneIdentity,
  type VisibleLaneTags,
} from "../../src/lib/lanes/read-wall"

export async function loadTargetLaneIdentities(db: AquillaDb, projectId: string): Promise<LaneIdentity[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, legacy_tag FROM lanes
        WHERE project_id = ? AND role = 'target'`,
    )
    .bind(projectId)
    .all<{ id: string; name: string; legacy_tag: string | null }>()
  return (results ?? []).map((row) => ({ id: row.id, name: row.name, legacyTag: row.legacy_tag }))
}

export async function loadTargetLaneIdentitiesForProjects(
  db: AquillaDb,
  projectIds: readonly string[],
): Promise<Map<string, LaneIdentity[]>> {
  const byProject = new Map<string, LaneIdentity[]>()
  if (projectIds.length === 0) return byProject
  const placeholders = projectIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(
      `SELECT project_id, id, name, legacy_tag FROM lanes
        WHERE role = 'target' AND project_id IN (${placeholders})`,
    )
    .bind(...projectIds)
    .all<{ project_id: string; id: string; name: string; legacy_tag: string | null }>()
  for (const row of results ?? []) {
    const list = byProject.get(row.project_id) ?? []
    list.push({ id: row.id, name: row.name, legacyTag: row.legacy_tag })
    byProject.set(row.project_id, list)
  }
  return byProject
}

export async function loadLaneGrants(db: AquillaDb, projectId: string, userId: number): Promise<LaneGrant[]> {
  const { results } = await db
    .prepare(
      `SELECT lane, role_level FROM project_member_lane_roles
        WHERE project_id = ? AND user_id = ?`,
    )
    .bind(projectId, userId)
    .all<{ lane: string; role_level: number }>()
  return (results ?? []).map((row) => ({ lane: row.lane, level: Number(row.role_level) }))
}

export async function loadLaneGrantsForProjects(
  db: AquillaDb,
  userId: number,
  projectIds: readonly string[],
): Promise<Map<string, LaneGrant[]>> {
  const byProject = new Map<string, LaneGrant[]>()
  if (projectIds.length === 0) return byProject
  const placeholders = projectIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(
      `SELECT project_id, lane, role_level FROM project_member_lane_roles
        WHERE user_id = ? AND project_id IN (${placeholders})`,
    )
    .bind(userId, ...projectIds)
    .all<{ project_id: string; lane: string; role_level: number }>()
  for (const row of results ?? []) {
    const list = byProject.get(row.project_id) ?? []
    list.push({ lane: row.lane, level: Number(row.role_level) })
    byProject.set(row.project_id, list)
  }
  return byProject
}

/** Grants for one member, or null when the wall does not restrict them. */
export async function visibleTagsForMember(
  db: AquillaDb,
  flag: string | undefined,
  projectId: string,
  userId: number,
  role: number,
): Promise<{ visible: VisibleLaneTags; lanes: LaneIdentity[] }> {
  if (!laneReadWallEnabled(flag) || role >= READ_WALL_MAINTAINER) {
    return { visible: null, lanes: [] }
  }
  const grants = await loadLaneGrants(db, projectId, userId)
  const visible = visibleLaneTags({ enabled: true, role, laneGrants: grants })
  const lanes = visible === null ? [] : await loadTargetLaneIdentities(db, projectId)
  return { visible, lanes }
}

/**
 * Settings blob a member may be shown. Wall off, and Maintainer+, return the
 * blob unchanged. Below that, `targetLanes` / `archivedLanes` / `targetLanguage`
 * keep only the granted lanes.
 */
export async function filterSettingsBlobForMember(
  db: AquillaDb,
  flag: string | undefined,
  projectId: string,
  userId: number,
  role: number,
  settings: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { visible, lanes } = await visibleTagsForMember(db, flag, projectId, userId, role)
  return filterSettingsToVisibleLanes({ settings }, visible, lanes).settings
}

/**
 * Lane labels an error response may echo back. `null` means the caller may
 * see the whole registry. A set is the granted names and legacy tags.
 */
export async function echoableLaneLabels(
  db: AquillaDb,
  flag: string | undefined,
  projectId: string,
  userId: number,
  role: number,
): Promise<ReadonlySet<string> | null> {
  const { visible, lanes } = await visibleTagsForMember(db, flag, projectId, userId, role)
  if (visible === null) return null
  return labelsForGrantedLanes(lanes, visible)
}
