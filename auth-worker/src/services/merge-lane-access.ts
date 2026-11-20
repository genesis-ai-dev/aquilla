// AQU-2355 — the people who worked on a merged sibling keep access to that work.
//
// A sibling merge folds project B (the donor) into project A (the host) as one
// new lane, then archives B. Nobody below Maintainer reaches a lane created
// later on its own (AQU-2351 rule 2), and archiving B ends every path into it,
// so without this the translators of B lose the work they did. Decided by Luke
// (2026-11-20): B's people keep it.
//
//   * Teams attached to B that covered the folded lane are linked to the new
//     lane on A (attached to A if they were not, at their role on B capped
//     below Maintainer, listing only that lane), and their roster is
//     reconciled — so the access stays a TEAM path, and leaving the team
//     takes it away again (AQU-2354). A team from another organization cannot
//     be attached to A; its members are carried as people instead.
//   * People with access to B in their own right (a direct membership or B's
//     creator) get a direct grant on the new lane at the lane role they had on
//     B: their grant on the folded lane, or Lane lead (500) for a Maintainer or
//     Owner of B, who read every lane. Someone who could not read the folded
//     lane on B gets nothing. Someone new to A joins it limited to that lane.
//   * Nobody is raised: a person already at Maintainer or above on A is left
//     alone, and an existing grant on the lane is never lowered.
//
// Org-level Maintainers of B's organization are not carried: in the same
// organization they already reach A, and across organizations a merge is not
// a way to hand out access to another organization's project.

import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { applyTeamRosterLaneChecks } from "./lane-grants"

const VIEWER = 100
const LANE_LEAD = 500
const MAINTAINER = 600

export interface CarryDonorLaneAccessInput {
  donorProjectId: string
  /** The donor lane that was folded; null reads every donor target lane. */
  donorLaneId: string | null
  hostProjectId: string
  hostLaneId: string
  grantedBy: number
}

export interface CarryDonorLaneAccessResult {
  people: number
  teams: number
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true"
}

/** Run before the donor is archived: it reads the donor's live access. */
export async function carryDonorLaneAccess(
  db: AquillaDb,
  input: CarryDonorLaneAccessInput,
): Promise<CarryDonorLaneAccessResult> {
  const { donorProjectId, donorLaneId, hostProjectId, hostLaneId, grantedBy } = input
  const host = await db
    .prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(hostProjectId)
    .first<{ org_id: number | string | null }>()
  const hostOrg = host?.org_id == null ? null : Number(host.org_id)

  const people = new Map<number, number>()
  const carry = (userId: number, level: number) => {
    if (level < VIEWER) return
    const capped = Math.min(level, LANE_LEAD)
    people.set(userId, Math.max(people.get(userId) ?? 0, capped))
  }

  // Teams that covered the folded lane on the donor.
  const { results: teamRows } = await db
    .prepare(
      `SELECT gpg.group_id, gpg.role_level, gpg.lanes_explicit, g.org_id
         FROM group_project_grants gpg
         JOIN groups g ON g.id = gpg.group_id
        WHERE gpg.project_id = ?`,
    )
    .bind(donorProjectId)
    .all<{ group_id: number | string; role_level: number; lanes_explicit: unknown; org_id: number | string }>()
  let teams = 0
  for (const row of teamRows ?? []) {
    const groupId = Number(row.group_id)
    if (flag(row.lanes_explicit)) {
      const covered = await db
        .prepare(
          `SELECT 1 AS ok FROM group_project_lanes gpl
             JOIN lanes l ON l.project_id = gpl.project_id AND l.id = gpl.lane_id AND l.role = 'target'
            WHERE gpl.group_id = ? AND gpl.project_id = ?${donorLaneId ? " AND gpl.lane_id = ?" : ""}
            LIMIT 1`,
        )
        .bind(...(donorLaneId ? [groupId, donorProjectId, donorLaneId] : [groupId, donorProjectId]))
        .first<{ ok: number }>()
      if (!covered) continue
    }
    const role = Math.min(Number(row.role_level), LANE_LEAD)
    if (hostOrg != null && Number(row.org_id) === hostOrg) {
      await db
        .prepare(
          `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by, lanes_explicit)
           VALUES (?, ?, ?, ?, TRUE)
           ON CONFLICT (group_id, project_id) DO NOTHING`,
        )
        .bind(groupId, hostProjectId, role, grantedBy)
        .run()
      await db
        .prepare(
          `INSERT INTO group_project_lanes (group_id, project_id, lane_id) VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(groupId, hostProjectId, hostLaneId)
        .run()
      await applyTeamRosterLaneChecks(db, groupId, hostProjectId, grantedBy)
      teams++
      continue
    }
    const { results: members } = await db
      .prepare("SELECT user_id, role_level FROM group_members WHERE group_id = ?")
      .bind(groupId)
      .all<{ user_id: number | string; role_level: number | null }>()
    for (const m of members ?? []) carry(Number(m.user_id), Math.max(role, Number(m.role_level ?? 0)))
  }

  // People in their own right: direct members and the donor's creator.
  const { results: directRows } = await db
    .prepare(
      `SELECT user_id FROM project_members WHERE project_id = ?
       UNION SELECT created_by FROM projects WHERE id = ?`,
    )
    .bind(donorProjectId, donorProjectId)
    .all<{ user_id: number | string }>()
  for (const row of directRows ?? []) {
    const userId = Number(row.user_id)
    const role = await resolveProjectRoleShared(db, { id: String(userId) }, donorProjectId)
    if (!role) continue
    if (role.level >= MAINTAINER) {
      carry(userId, LANE_LEAD)
      continue
    }
    const grant = await db
      .prepare(
        `SELECT MAX(g.role_level) AS level FROM project_member_lane_roles g
           JOIN lanes l ON l.project_id = g.project_id AND l.id = g.lane AND l.role = 'target'
          WHERE g.project_id = ? AND g.user_id = ?${donorLaneId ? " AND g.lane = ?" : ""}`,
      )
      .bind(...(donorLaneId ? [donorProjectId, userId, donorLaneId] : [donorProjectId, userId]))
      .first<{ level: number | null }>()
    if (grant?.level != null) carry(userId, Number(grant.level))
  }

  let carried = 0
  for (const [userId, level] of people) {
    const hostRole = await resolveProjectRoleShared(db, { id: String(userId) }, hostProjectId)
    if (hostRole && hostRole.level >= MAINTAINER) continue
    const member = await db
      .prepare("SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(hostProjectId, userId)
      .first<{ ok: number }>()
    const scoped = await db
      .prepare("SELECT 1 AS ok FROM project_member_scopes WHERE project_id = ? AND user_id = ? AND kind = 'lane' LIMIT 1")
      .bind(hostProjectId, userId)
      .first<{ ok: number }>()
    if (!member) {
      await db
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(hostProjectId, userId, level, grantedBy)
        .run()
    }
    if (!member || scoped) {
      // Someone new to A is limited to the merged lane; a limited member gains it.
      await db
        .prepare(
          `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
           VALUES (?, ?, 'lane', ?, ?, ?)
           ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
        )
        .bind(hostProjectId, userId, hostLaneId, String(grantedBy), Date.now())
        .run()
    }
    await db
      .prepare(
        `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, user_id, lane)
         DO UPDATE SET role_level = GREATEST(project_member_lane_roles.role_level, excluded.role_level),
                       team_group_id = NULL`,
      )
      .bind(hostProjectId, userId, hostLaneId, level, grantedBy)
      .run()
    carried++
  }
  return { people: carried, teams }
}
