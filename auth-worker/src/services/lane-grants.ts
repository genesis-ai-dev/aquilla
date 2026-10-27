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
// AQU-1809: changing one member's team-scope role
// (PATCH .../groups/:groupId/members/:userId) does not open or close lanes.
// relevelTeamMemberLaneGrants moves the rows that member already holds.
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

import { resolveProjectRoleViaGrants } from "../../../db/shared/access-grants"
import { loadCurrentTargetLanes, loadTargetLaneIdentities } from "../../../db/shared/lane-visibility"
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
  for (const projectId of new Set(projectIds)) {
    if (await hasDirectMembership(db, projectId, userId)) {
      const role = await resolveProjectRoleShared(db, { id: String(userId) }, projectId)
      if (!role) continue
      await applyDirectAddLaneGrants(db, projectId, userId, role.level, null)
      continue
    }
    // A project reached only through a team uses that attachment's lanes
    // (AQU-1800 / AQU-1813), not "every lane" when the team has named some.
    await reconcileMemberProjectLanes(db, projectId, userId, null)
  }
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
 * "every current lane" stores for a role below project lead. A project lead
 * stores one scope per current target lane instead, so a lane created later
 * is not included until someone grants it.
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

/** Lane-grant rows stop at contributor. A team may still confer project lead. */
const LANE_GRANT_CAP = 400
const PROJECT_LEAD = 500
const MAINTAINER = 600
const VIEWER = 100

export type TeamLaneSelection =
  | { explicit: false }
  | { explicit: true; laneIds: string[] }

/**
 * The lanes a team attachment may store. Omitting the list keeps the living
 * "every lane" attachment (Codex, and callers that predate the checkboxes).
 * Naming lanes freezes the attachment to those lanes.
 */
export async function resolveTeamLaneSelection(
  db: AquillaDb,
  projectId: string,
  laneIds: readonly string[] | undefined,
): Promise<{ ok: true; selection: TeamLaneSelection } | { ok: false; error: string }> {
  if (laneIds == null) return { ok: true, selection: { explicit: false } }
  const current = await loadCurrentTargetLanes(db, projectId)
  if (current.length > 0 && laneIds.length === 0) {
    return { ok: false, error: "Choose at least one target lane." }
  }
  const allowed = new Set(current.map((lane) => lane.id))
  const unknown = laneIds.filter((id) => !allowed.has(id))
  if (unknown.length > 0) {
    return { ok: false, error: "laneIds must name current target lanes of this project" }
  }
  return { ok: true, selection: { explicit: true, laneIds: [...laneIds] } }
}

/** Remember which lanes an attachment covers. The grant row must already exist. */
export async function saveTeamLaneSelection(
  db: AquillaDb,
  groupId: number,
  projectId: string,
  selection: TeamLaneSelection,
): Promise<void> {
  await db
    .prepare(
      `UPDATE group_project_grants SET lanes_explicit = ${selection.explicit ? "TRUE" : "FALSE"}
        WHERE group_id = ? AND project_id = ?`,
    )
    .bind(groupId, projectId)
    .run()
  await db
    .prepare("DELETE FROM group_project_lanes WHERE group_id = ? AND project_id = ?")
    .bind(groupId, projectId)
    .run()
  if (!selection.explicit) return
  for (const laneId of selection.laneIds) {
    await db
      .prepare(
        `INSERT INTO group_project_lanes (group_id, project_id, lane_id)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(groupId, projectId, laneId)
      .run()
  }
}

/**
 * AQU-1801 / AQU-1813 — grants for someone just added to a team.
 *
 * Each attached project contributes its stored lanes. Two teams union. A
 * direct member who is not lane-scoped keeps the lanes they had and gains
 * the team's. A member below project lead who is lane-scoped keeps exactly
 * those lanes (AQU-1818). Someone with no direct membership is rewritten to
 * the teams they are on now, which drops rows an earlier membership left.
 */
export async function applyTeamMemberLaneGrants(
  db: AquillaDb,
  groupId: number,
  userId: number,
  grantedBy: number | null,
): Promise<void> {
  const projectIds = await loadTeamProjectIds(db, groupId)
  for (const projectId of projectIds) {
    await reconcileMemberProjectLanes(db, projectId, userId, grantedBy)
  }
}

/**
 * AQU-1809 — a team-scope role change re-levels one member's existing grants.
 *
 * Called only from PATCH .../groups/:groupId/members/:userId. The lane set
 * stays: a row that exists takes the role this member now holds, and a
 * project with no rows is left empty. Lane scopes are not read and not
 * written. Maintainer and above hold no rows. The statement is an update or
 * a delete, so it cannot insert a duplicate.
 *
 * The level is the access_grants answer (max-wins across the direct, team
 * and org paths, which is where a team-scope role counts). The flag-selected
 * resolver still ignores that role; this does not change the flag.
 */
export async function relevelTeamMemberLaneGrants(
  db: AquillaDb,
  groupId: number,
  userId: number,
): Promise<void> {
  const projectIds = await loadTeamProjectIds(db, groupId)
  for (const projectId of projectIds) {
    const role = await resolveProjectRoleViaGrants(db, { id: String(userId) }, projectId)
    if (!role) continue
    if (role.level >= MAINTAINER || role.level < VIEWER) {
      await db
        .prepare("DELETE FROM project_member_lane_roles WHERE project_id = ? AND user_id = ?")
        .bind(projectId, userId)
        .run()
      continue
    }
    await db
      .prepare(
        "UPDATE project_member_lane_roles SET role_level = ? WHERE project_id = ? AND user_id = ?",
      )
      .bind(role.level, projectId, userId)
      .run()
  }
}

/**
 * AQU-1801 — re-level the grants a team's roster already holds.
 *
 * Changing the team's role does not change which lanes are checked. A lane
 * grant is capped at contributor: the attachment may still confer project
 * lead, and that role is what the management actions read.
 *
 * AQU-1818: a lane scope with no direct membership is an earlier membership
 * that has ended. Those rows are not the member's current lanes, so the
 * team attachment replaces them. A grant set with no scope is left as it is
 * and only re-levelled — that is a current team member whose lanes are
 * narrower than the project's (AQU-1801).
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
    const userId = Number(row.user_id)
    const role = await resolveProjectRoleShared(db, { id: String(userId) }, projectId)
    if (!role || role.level >= MAINTAINER || role.level < VIEWER) continue
    const level = Math.min(role.level, LANE_GRANT_CAP)
    if (await endedMembershipLeftScopes(db, projectId, userId)) {
      await replaceLaneRows(db, projectId, userId, await teamLaneAccess(db, userId, projectId), level, grantedBy)
      continue
    }
    await applyDirectAddLaneGrants(db, projectId, userId, level, grantedBy)
  }
}

/** Rewrite one person's lanes from the teams that still reach this project. */
export async function reconcileMemberProjectLanes(
  db: AquillaDb,
  projectId: string,
  userId: number,
  grantedBy: number | null,
): Promise<void> {
  const role = await resolveProjectRoleShared(db, { id: String(userId) }, projectId)
  if (!role || role.level >= MAINTAINER || role.level < VIEWER) {
    if (!role) await clearLaneRows(db, projectId, userId)
    return
  }
  const access = await teamLaneAccess(db, userId, projectId)
  const level = Math.min(role.level, LANE_GRANT_CAP)
  if (!(await hasDirectMembership(db, projectId, userId))) {
    await replaceLaneRows(db, projectId, userId, access, level, grantedBy)
    return
  }
  // A current member below project lead who already has a lane scope keeps
  // exactly those lanes. A team path must not widen them, and must not delete
  // the scope. Project leads and unscoped members fall through.
  if (role.level < PROJECT_LEAD && (await loadMemberLaneScopes(db, projectId, userId)).length > 0) {
    return
  }
  await unionTeamLanesIntoDirect(db, projectId, userId, access, level, grantedBy)
}

/**
 * Lane scopes belong to a direct membership. Once that row is gone, any
 * scope still stored is an earlier membership, unless an explicit team
 * attachment wrote those exact lanes for the person it still reaches.
 */
async function endedMembershipLeftScopes(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<boolean> {
  if (await hasDirectMembership(db, projectId, userId)) return false
  const scopes = await loadMemberLaneScopes(db, projectId, userId)
  if (scopes.length === 0) return false
  const access = await teamLaneAccess(db, userId, projectId)
  if (!access.explicit) return true
  const team = new Set(access.laneIds)
  return scopes.length !== team.size || scopes.some((id) => !team.has(id))
}

/** After a team is attached or its checks change, rewrite every member. */
export async function applyTeamRosterLaneChecks(
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
    await reconcileMemberProjectLanes(db, projectId, Number(row.user_id), grantedBy)
  }
}

/**
 * The person who just created a lane can see it, even when they are below
 * maintainer and were not granted every other lane. Maintainer and above
 * already see it through the wall.
 */
export async function grantCreatedLaneToActor(
  db: AquillaDb,
  projectId: string,
  laneId: string,
  userId: number,
): Promise<void> {
  const role = await resolveProjectRoleShared(db, { id: String(userId) }, projectId)
  if (!role || role.level >= MAINTAINER || role.level < VIEWER) return
  const level = Math.min(role.level, LANE_GRANT_CAP)
  await db
    .prepare(
      `INSERT INTO project_member_lane_roles
         (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
    .bind(projectId, userId, laneId, level, userId)
    .run()
  const scopes = await loadMemberLaneScopes(db, projectId, userId)
  if (scopes.length === 0 || scopes.includes(laneId)) return
  await db
    .prepare(
      `INSERT INTO project_member_scopes
         (project_id, user_id, kind, value, created_by, created_at)
       VALUES (?, ?, 'lane', ?, ?, ?)
       ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
    )
    .bind(projectId, userId, laneId, String(userId), Date.now())
    .run()
}

/** A freshly added project lead is scoped to the lanes that exist then. */
export async function grantCurrentLanesToMember(
  db: AquillaDb,
  projectId: string,
  userId: number,
  createdBy: number,
): Promise<void> {
  const ids = (await loadCurrentTargetLanes(db, projectId)).map((lane) => lane.id)
  await replaceMemberLaneScopes(db, projectId, userId, ids, createdBy)
  await syncMemberLaneGrants(db, projectId, userId, ids, createdBy)
}

function laneFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true"
}

/**
 * AQU-2047: every team attached to this project, and the lanes that attachment
 * is tied to. A team that has not saved checkboxes (`lanesExplicit` false) is
 * tied to every current target lane — the stored rows, if any are left behind,
 * are not its set. An explicit team is tied only to its `group_project_lanes`
 * rows. An empty list is a project with no attached team.
 */
export interface ProjectTeamLaneAttachment {
  lanesExplicit: boolean
  laneIds?: string[]
}

export async function loadProjectTeamLaneAttachments(
  db: AquillaDb,
  projectId: string,
): Promise<ProjectTeamLaneAttachment[]> {
  const { results } = await db
    .prepare(
      `SELECT group_id, lanes_explicit
         FROM group_project_grants
        WHERE project_id = ?
        ORDER BY group_id`,
    )
    .bind(projectId)
    .all<{ group_id: number | string; lanes_explicit: boolean | number | string }>()
  const teams = results ?? []
  if (teams.length === 0) return []

  const { results: laneRows } = await db
    .prepare(
      `SELECT group_id, lane_id
         FROM group_project_lanes
        WHERE project_id = ?
        ORDER BY group_id, lane_id`,
    )
    .bind(projectId)
    .all<{ group_id: number | string; lane_id: string }>()
  const lanesByGroup = new Map<number, string[]>()
  for (const row of laneRows ?? []) {
    const groupId = Number(row.group_id)
    const list = lanesByGroup.get(groupId) ?? []
    list.push(row.lane_id)
    lanesByGroup.set(groupId, list)
  }

  return teams.map((team) => {
    if (!laneFlag(team.lanes_explicit)) return { lanesExplicit: false }
    return {
      lanesExplicit: true,
      laneIds: lanesByGroup.get(Number(team.group_id)) ?? [],
    }
  })
}

async function teamLaneAccess(
  db: AquillaDb,
  userId: number,
  projectId: string,
): Promise<{ explicit: boolean; laneIds: string[] }> {
  const { results } = await db
    .prepare(
      `SELECT gpg.group_id AS group_id, gpg.lanes_explicit AS lanes_explicit
         FROM group_project_grants gpg
         JOIN group_members gm ON gm.group_id = gpg.group_id
        WHERE gpg.project_id = ? AND gm.user_id = ?`,
    )
    .bind(projectId, userId)
    .all<{ group_id: number; lanes_explicit: boolean | number | string }>()
  const teams = results ?? []
  if (teams.length === 0) return { explicit: true, laneIds: [] }
  if (teams.some((team) => !laneFlag(team.lanes_explicit))) {
    const lanes = await loadTargetLaneIdentities(db, projectId)
    return { explicit: false, laneIds: lanes.map((lane) => lane.id) }
  }
  const ids = new Set<string>()
  for (const team of teams) {
    for (const laneId of await loadStoredTeamLaneIds(db, Number(team.group_id), projectId)) {
      ids.add(laneId)
    }
  }
  return { explicit: true, laneIds: [...ids] }
}

async function loadStoredTeamLaneIds(
  db: AquillaDb,
  groupId: number,
  projectId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT lane_id FROM group_project_lanes WHERE group_id = ? AND project_id = ? ORDER BY lane_id",
    )
    .bind(groupId, projectId)
    .all<{ lane_id: string }>()
  return (results ?? []).map((row) => row.lane_id)
}

async function hasDirectMembership(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .first<{ ok: number }>()
  return row != null
}

async function clearLaneRows(db: AquillaDb, projectId: string, userId: number): Promise<void> {
  await db
    .prepare(
      "DELETE FROM project_member_scopes WHERE project_id = ? AND user_id = ? AND kind = 'lane'",
    )
    .bind(projectId, userId)
    .run()
  await db
    .prepare("DELETE FROM project_member_lane_roles WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .run()
}

async function replaceLaneRows(
  db: AquillaDb,
  projectId: string,
  userId: number,
  access: { explicit: boolean; laneIds: string[] },
  level: number,
  grantedBy: number | null,
): Promise<void> {
  await clearLaneRows(db, projectId, userId)
  if (access.explicit) {
    const now = Date.now()
    for (const laneId of access.laneIds) {
      await db
        .prepare(
          `INSERT INTO project_member_scopes
             (project_id, user_id, kind, value, created_by, created_at)
           VALUES (?, ?, 'lane', ?, ?, ?)
           ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
        )
        .bind(projectId, userId, laneId, grantedBy == null ? "0" : String(grantedBy), now)
        .run()
    }
  }
  for (const laneId of access.laneIds) {
    await insertLaneGrant(db, projectId, userId, laneId, level, grantedBy)
  }
}

async function unionTeamLanesIntoDirect(
  db: AquillaDb,
  projectId: string,
  userId: number,
  access: { explicit: boolean; laneIds: string[] },
  level: number,
  grantedBy: number | null,
): Promise<void> {
  if (!access.explicit) {
    // A living attachment is every lane, including one created later, which
    // is stored as no lane scopes. A direct scope list would hide that.
    await db
      .prepare(
        "DELETE FROM project_member_scopes WHERE project_id = ? AND user_id = ? AND kind = 'lane'",
      )
      .bind(projectId, userId)
      .run()
  } else {
    const scopes = new Set(await loadMemberLaneScopes(db, projectId, userId))
    if (scopes.size > 0) {
      const now = Date.now()
      for (const laneId of access.laneIds) {
        if (scopes.has(laneId)) continue
        await db
          .prepare(
            `INSERT INTO project_member_scopes
               (project_id, user_id, kind, value, created_by, created_at)
             VALUES (?, ?, 'lane', ?, ?, ?)
             ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
          )
          .bind(projectId, userId, laneId, grantedBy == null ? "0" : String(grantedBy), now)
          .run()
      }
    }
  }
  const { results } = await db
    .prepare("SELECT lane FROM project_member_lane_roles WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .all<{ lane: string }>()
  const held = new Set((results ?? []).map((row) => row.lane))
  for (const laneId of access.laneIds) {
    if (held.has(laneId)) continue
    await insertLaneGrant(db, projectId, userId, laneId, level, grantedBy)
  }
}

async function insertLaneGrant(
  db: AquillaDb,
  projectId: string,
  userId: number,
  laneId: string,
  level: number,
  grantedBy: number | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_member_lane_roles
         (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
    .bind(projectId, userId, laneId, level, grantedBy)
    .run()
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
