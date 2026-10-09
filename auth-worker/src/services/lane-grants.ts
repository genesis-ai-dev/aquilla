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
// AQU-1801 added the team paths: adding someone to a team, attaching a team to
// a project, and changing a team's role on a project all open (or re-level) a
// project through `group_project_grants` x `group_members` and wrote no grants
// either, so anyone admitted through a team after the AQU-730 backfill reached
// the project with no readable target lane. All three now go through
// applyTeamMemberLaneGrants / applyTeamProjectLaneGrants below.
//
// AQU-1799 added a fourth: the Codex/GitLab account migration
// (services/legacy-user-migration.ts) writes org, team and project
// memberships in one transaction and wrote no grants either, so every account
// migrated after the AQU-730 backfill — at first sign-in or by the nightly
// import — was walled off from every target lane of every project it was just
// given. It now calls applyMigratedMemberLaneGrants below, inside that same
// transaction.
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

import { loadTargetLaneIdentities } from "../../../db/shared/lane-visibility"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
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
  // Every target lane, archived included, and that matters for an unscoped
  // member: AQU-1781 grants a newly created lane only to someone who already
  // holds every OTHER lane, archived ones too. Leaving the archived lanes out
  // here would make the member's next lane silently skip them (AQU-1783).
  const lanes = await loadTargetLaneIdentities(db, projectId)
  if (lanes.length === 0) return
  const plan = planLaneGrants({
    roleLevel: Number(membership.role_level),
    laneScopes: laneIds,
    lanes,
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
  // Null for a writer with no human actor behind it: the Codex/GitLab
  // migration (AQU-1799) writes every other membership row with
  // `granted_by NULL` for the same reason, and the column is nullable.
  grantedBy: number | null,
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

/**
 * AQU-1799 — grants for every project a freshly written membership set opens.
 *
 * The Codex/GitLab migration copies a person's whole access in one atomic
 * step: org memberships, team memberships and direct project memberships. Each
 * of those can open a project, and under the read wall a below-Maintainer
 * member reads a target lane only through a grant row — so the migration has
 * to write grants for the projects it just opened or the person signs in to a
 * project with no editable lane.
 *
 * `projectIds` is the set of projects the caller's membership writes reach
 * (direct memberships, plus the projects attached to the teams it joined).
 * The role is re-resolved per project rather than taken from the plan, because
 * the effective role is max-wins across the direct, team and org paths
 * (AD-12): a Developer on the project who is also a Maintainer on its org
 * resolves to Maintainer and must get no rows at all. Projects the person
 * cannot actually reach (archived, or no surviving path) are skipped.
 *
 * Per project the work is `applyDirectAddLaneGrants`, so a migrated account and
 * an account added by hand land in exactly the same place — including the
 * "rows already exist → rewrite the level only" rule, which leaves a
 * pre-seeded lane-scoped account reading exactly the lanes it was scoped to.
 */
export async function applyMigratedMemberLaneGrants(
  db: AquillaDb,
  userId: number,
  projectIds: readonly string[],
): Promise<void> {
  await applyMemberLaneGrantsForProjects(db, userId, projectIds, null)
}

/**
 * One person, the projects a membership write just opened or re-levelled.
 *
 * The role is re-resolved per project rather than taken from the caller's
 * write, because the effective role is max-wins across the direct, team and
 * org paths (AD-12): a Contributor on the team who is also a Maintainer on the
 * org resolves to Maintainer and must get no rows at all. Projects the person
 * cannot actually reach (archived, or no surviving path) are skipped. Per
 * project the work is `applyDirectAddLaneGrants`, so every admission path
 * lands a member in the same place.
 */
export async function applyMemberLaneGrantsForProjects(
  db: AquillaDb,
  userId: number,
  projectIds: readonly string[],
  grantedBy: number | null,
): Promise<void> {
  for (const projectId of new Set(projectIds)) {
    const role = await resolveProjectRoleShared(db, { id: String(userId) }, projectId)
    if (!role) continue
    await applyDirectAddLaneGrants(db, projectId, userId, role.level, grantedBy)
  }
}

/**
 * AQU-1808 — the kind='lane' scope rows an explicit lane choice names,
 * replacing whatever rows the person already had on this project.
 *
 * Removing a member deletes only `project_members` (DELETE /members/:id and
 * revoke-all alike), so the scope rows of an earlier membership survive. A
 * re-add used to union the new choice into them, which kept a stale narrow
 * row under "every current lane" — the client's lane list then forced the
 * person onto that one lane. An empty list deletes the rows: that is what
 * "every current lane" stores, and what a project lead holds (AD-12: a lead
 * is never lane-scoped).
 */
export async function replaceMemberLaneScopes(
  db: AquillaDb,
  projectId: string,
  userId: number,
  laneIds: readonly string[],
  createdBy: number,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM project_member_scopes WHERE project_id = ? AND user_id = ? AND kind = 'lane'",
    )
    .bind(projectId, userId)
    .run()
  const now = Date.now()
  for (const laneId of laneIds) {
    await db
      .prepare(
        `INSERT INTO project_member_scopes
           (project_id, user_id, kind, value, created_by, created_at)
         VALUES (?, ?, 'lane', ?, ?, ?)
         ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
      )
      .bind(projectId, userId, laneId, String(createdBy), now)
      .run()
  }
}

/**
 * AQU-1801 — grants for someone just added to a team.
 *
 * A `group_members` row opens every project the team is attached to, so the
 * new member needs grants on each of them. Nothing here is team-specific
 * beyond the project list: the role is re-resolved per project by
 * `applyMemberLaneGrantsForProjects`, and a member who already holds rows on
 * one of those projects (a direct membership, an invite, an earlier team) has
 * only their level rewritten, so joining a team never widens the lane set they
 * could already read.
 */
export async function applyTeamMemberLaneGrants(
  db: AquillaDb,
  groupId: number,
  userId: number,
  grantedBy: number | null,
): Promise<void> {
  const projectIds = await loadTeamProjectIds(db, groupId)
  if (projectIds.length === 0) return
  await applyMemberLaneGrantsForProjects(db, userId, projectIds, grantedBy)
}

/**
 * AQU-1801 — grants for a team's whole roster on one project.
 *
 * Covers both writes that change what a team's members hold on a project:
 * attaching the team (every member reaches a project they could not before)
 * and changing the team's role on it (the same people, a new level). The
 * level case needs no special handling — `applyDirectAddLaneGrants` rewrites
 * the level on the rows a member already has, so a demotion to Viewer leaves
 * them reading exactly the lanes they could edit before, and the promotion
 * back restores editing on those same lanes.
 */
export async function applyTeamProjectLaneGrants(
  db: AquillaDb,
  groupId: number,
  projectId: string,
  grantedBy: number | null,
): Promise<void> {
  const { results } = await db
    .prepare("SELECT user_id FROM group_members WHERE group_id = ?")
    .bind(groupId)
    .all<{ user_id: number }>()
  for (const row of results ?? []) {
    await applyMemberLaneGrantsForProjects(db, Number(row.user_id), [projectId], grantedBy)
  }
}

/** The projects a team is attached to. */
async function loadTeamProjectIds(db: AquillaDb, groupId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT project_id FROM group_project_grants WHERE group_id = ?")
    .bind(groupId)
    .all<{ project_id: string }>()
  return (results ?? []).map((row) => row.project_id)
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
