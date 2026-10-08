// AQU-1782 — one place that writes a member's lane grant rows.
//
// Under the lane read/write wall (AQU-730 / AQU-1415) a member below
// Maintainer sees and writes a target lane only through a
// project_member_lane_roles row. Three surfaces create membership, and before
// this ticket only two of them wrote grants:
//
//   - invite accept        → services/invite-scopes.ts (chosen lanes, or all)
//   - staffing / scopes    → routes/member-scopes.ts   (the scopes just stored)
//   - direct add / role    → routes/projects.ts        (nothing — the bug)
//
// A directly-added contributor therefore held zero grants: no target lane in
// the switcher, no target cells, 0% progress, while the project lead saw
// everything. Both writers now live here so the three paths cannot drift
// again.
//
// Shape of a grant set, in both functions: the planner
// (src/lib/lanes/grant-backfill.ts) decides it — Maintainer+ and below Viewer
// get no rows (their role already clears the wall), an unscoped member gets
// one row per current target lane, a lane-scoped member gets one row per
// scoped lane. A project with no lane rows yet is left alone: there is
// nothing to point a grant at, and the AQU-730 backfill fills both tables
// later.

import { loadCurrentTargetLanes, loadTargetLaneIdentities } from "../../../db/shared/lane-visibility"
import { planLaneGrants } from "../../../src/lib/lanes/grant-backfill"

/**
 * Replace a member's grant rows with the set implied by `laneIds` at their
 * current project role. Used when the *scope* set changes (member-scopes PUT),
 * where the stored scopes are authoritative and the old rows must not survive.
 */
export async function syncMemberLaneGrants(
  db: AquillaDb,
  projectId: string,
  targetUserId: number,
  laneIds: readonly string[],
  grantedBy: number,
): Promise<void> {
  const membership = await db
    .prepare("SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, targetUserId)
    .first<{ role_level: number }>()
  if (!membership) return
  const lanes = await loadTargetLaneIdentities(db, projectId)
  if (lanes.length === 0) return
  // AQU-1783: an unscoped member is granted the project's CURRENT lanes. A
  // scope still resolves against every lane, archived included, so a member
  // deliberately scoped to a since-archived lane keeps that grant.
  const plan = planLaneGrants({
    roleLevel: Number(membership.role_level),
    laneScopes: laneIds,
    lanes,
    fanOutLanes: await loadCurrentTargetLanes(db, projectId),
  })
  await db
    .prepare("DELETE FROM project_member_lane_roles WHERE project_id = ? AND user_id = ?")
    .bind(projectId, targetUserId)
    .run()
  for (const grant of plan.grants) {
    await db
      .prepare(
        `INSERT INTO project_member_lane_roles
           (project_id, user_id, lane, role_level, granted_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(projectId, targetUserId, grant.laneId, grant.level, grantedBy)
      .run()
  }
}

/**
 * Bring a member's grant rows in line with a membership row that was just
 * written directly (POST /projects/:id/members — add, or re-add at a new
 * role). Unlike `syncMemberLaneGrants` this never *changes which lanes* an
 * existing member reads:
 *
 *   - rows already exist → only their level is rewritten, so a contributor
 *     promoted to reviewer keeps reading exactly the lanes they could before
 *     (their set may be narrower than "every lane" for reasons this route
 *     cannot see, and a role change must not widen it);
 *   - no rows yet → plan a fresh set from the member's stored lane scopes,
 *     which is the same planner call invite acceptance makes, so a direct add
 *     and an invite accept land the member in the same place.
 *
 * Idempotent: re-adding a member at the same role rewrites the same levels and
 * inserts nothing new.
 */
export async function applyDirectAddLaneGrants(
  db: AquillaDb,
  projectId: string,
  targetUserId: number,
  roleLevel: number,
  grantedBy: number,
): Promise<void> {
  const lanes = await loadTargetLaneIdentities(db, projectId)
  if (lanes.length === 0) return

  const { results } = await db
    .prepare("SELECT lane FROM project_member_lane_roles WHERE project_id = ? AND user_id = ?")
    .bind(projectId, targetUserId)
    .all<{ lane: string }>()
  if ((results ?? []).length > 0) {
    // Maintainer+ rows are left as they are rather than deleted: the wall
    // ignores them at that role, and they are what a later demotion through
    // this same route restores the member's lane set from.
    await db
      .prepare(
        "UPDATE project_member_lane_roles SET role_level = ? WHERE project_id = ? AND user_id = ?",
      )
      .bind(roleLevel, projectId, targetUserId)
      .run()
    return
  }

  const laneScopes = await loadMemberLaneScopes(db, projectId, targetUserId)
  const plan = planLaneGrants({ roleLevel, laneScopes, lanes })
  for (const grant of plan.grants) {
    await db
      .prepare(
        `INSERT INTO project_member_lane_roles
           (project_id, user_id, lane, role_level, granted_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
      )
      .bind(projectId, targetUserId, grant.laneId, grant.level, grantedBy)
      .run()
  }
}

/** The member's stored kind='lane' scopes. Empty = unscoped = every lane. */
async function loadMemberLaneScopes(
  db: AquillaDb,
  projectId: string,
  targetUserId: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT value FROM project_member_scopes
        WHERE project_id = ? AND user_id = ? AND kind = 'lane'`,
    )
    .bind(projectId, targetUserId)
    .all<{ value: string }>()
  return (results ?? []).map((row) => row.value)
}
