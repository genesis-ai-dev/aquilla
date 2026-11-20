// AQU-2355 — who a new lane is given to, chosen in the step that creates it.
//
// A lane grant grants only the lanes it lists (AQU-2351 rule 2), so a lane
// created later reaches nobody below Maintainer on its own. The create step
// offers the people and teams already on the project's OTHER lanes, unticked,
// each with the role they hold there; the creator ticks the ones who should
// have the new lane too. Ticking a Contributor gives them Contributor on the
// new lane and nothing else.
//
//   * people: direct project members below Maintainer who hold a grant on
//     another current target lane. Someone who reaches the project only
//     through a team is offered as that team — their lanes are the team's
//     (`reconcileMemberProjectLanes` rewrites a team-only member's rows from
//     the team), so a per-person row would not survive the next team change.
//   * teams: teams attached to the project whose attachment lists another
//     current target lane.
//
// A creator below Maintainer is offered only people and teams on lanes they
// can read themselves, and sees only those lanes' names: the strict silence
// about other lanes (AQU-1785) holds here too. Nobody is offered a role above
// Contributor's lane-grant cap, and nothing here can raise anyone: the level
// written is the one they already hold on another lane.

import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { loadCurrentTargetLanes } from "../../../db/shared/lane-visibility"
import { linkTeamsToLaneStmts } from "../../../db/shared/lane-grants"
import { applyTeamRosterLaneChecks } from "./lane-grants"

const VIEWER = 100
const MAINTAINER = 600

export interface NewLanePersonCandidate {
  userId: number
  username: string
  displayName: string | null
  /** The highest role they hold on the other lanes listed. */
  roleLevel: number
  laneNames: string[]
}

export interface NewLaneTeamCandidate {
  groupId: number
  name: string
  /** The attachment's role on this project. */
  roleLevel: number
  memberCount: number
  laneNames: string[]
}

export interface NewLaneGrantCandidates {
  people: NewLanePersonCandidate[]
  teams: NewLaneTeamCandidate[]
}

export interface NewLaneGrantPicks {
  userIds?: readonly number[]
  teamIds?: readonly number[]
}

/**
 * The people and teams the create step offers. `excludeLaneId` leaves out the
 * lane being created (so the list is "on the OTHER lanes" after the insert).
 */
export async function loadNewLaneGrantCandidates(
  db: AquillaDb,
  projectId: string,
  caller: { id: number; roleLevel: number },
  excludeLaneId?: string,
): Promise<NewLaneGrantCandidates> {
  const lanes = (await loadCurrentTargetLanes(db, projectId)).filter((lane) => lane.id !== excludeLaneId)
  let readable = new Set(lanes.map((lane) => lane.id))
  if (caller.roleLevel < MAINTAINER) {
    const { results } = await db
      .prepare(
        `SELECT lane FROM project_member_lane_roles
          WHERE project_id = ? AND user_id = ? AND role_level >= ${VIEWER}`,
      )
      .bind(projectId, caller.id)
      .all<{ lane: string }>()
    const mine = new Set((results ?? []).map((row) => row.lane))
    readable = new Set([...readable].filter((id) => mine.has(id)))
  }
  if (readable.size === 0) return { people: [], teams: [] }
  const laneName = new Map(lanes.map((lane) => [lane.id, lane.name]))

  const { results: grantRows } = await db
    .prepare(
      `SELECT g.user_id, g.lane, g.role_level, pm.role_level AS project_role,
              u.username, u.display_name
         FROM project_member_lane_roles g
         JOIN project_members pm ON pm.project_id = g.project_id AND pm.user_id = g.user_id
         JOIN users u ON u.id = g.user_id
        WHERE g.project_id = ? AND g.role_level >= ${VIEWER}`,
    )
    .bind(projectId)
    .all<{
      user_id: number | string
      lane: string
      role_level: number
      project_role: number
      username: string
      display_name: string | null
    }>()
  const people = new Map<number, NewLanePersonCandidate & { projectRole: number }>()
  for (const row of grantRows ?? []) {
    if (!readable.has(row.lane)) continue
    const userId = Number(row.user_id)
    if (userId === caller.id) continue
    const entry = people.get(userId) ?? {
      userId,
      username: row.username,
      displayName: row.display_name ?? null,
      roleLevel: 0,
      laneNames: [],
      projectRole: Number(row.project_role),
    }
    entry.roleLevel = Math.max(entry.roleLevel, Number(row.role_level))
    entry.laneNames.push(laneName.get(row.lane) ?? row.lane)
    people.set(userId, entry)
  }
  const keptPeople: NewLanePersonCandidate[] = []
  for (const entry of people.values()) {
    // Maintainers and Owners see the new lane by role; nothing to offer.
    const role = await resolveProjectRoleShared(db, { id: String(entry.userId) }, projectId)
    if (!role || role.level >= MAINTAINER || role.level < VIEWER) continue
    keptPeople.push({
      userId: entry.userId,
      username: entry.username,
      displayName: entry.displayName,
      roleLevel: Math.min(Math.max(entry.roleLevel, entry.projectRole), MAINTAINER - 100),
      laneNames: entry.laneNames.sort((a, b) => a.localeCompare(b)),
    })
  }
  keptPeople.sort((a, b) => (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username))

  const { results: teamRows } = await db
    .prepare(
      `SELECT gpg.group_id, g.name, gpg.role_level, gpl.lane_id,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = gpg.group_id) AS member_count
         FROM group_project_grants gpg
         JOIN groups g ON g.id = gpg.group_id
         JOIN group_project_lanes gpl ON gpl.group_id = gpg.group_id AND gpl.project_id = gpg.project_id
        WHERE gpg.project_id = ? AND gpg.role_level < ${MAINTAINER}`,
    )
    .bind(projectId)
    .all<{ group_id: number | string; name: string; role_level: number; lane_id: string; member_count: number | string }>()
  const teams = new Map<number, NewLaneTeamCandidate>()
  for (const row of teamRows ?? []) {
    if (!readable.has(row.lane_id)) continue
    const groupId = Number(row.group_id)
    const entry = teams.get(groupId) ?? {
      groupId,
      name: row.name,
      roleLevel: Number(row.role_level),
      memberCount: Number(row.member_count),
      laneNames: [],
    }
    entry.laneNames.push(laneName.get(row.lane_id) ?? row.lane_id)
    teams.set(groupId, entry)
  }
  const keptTeams = [...teams.values()]
    .map((team) => ({ ...team, laneNames: team.laneNames.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { people: keptPeople, teams: keptTeams }
}

/** Picks that are not on the offered list, or null when every pick is offered. */
export function unofferedPicks(candidates: NewLaneGrantCandidates, picks: NewLaneGrantPicks): string | null {
  const people = new Set(candidates.people.map((p) => p.userId))
  const teams = new Set(candidates.teams.map((t) => t.groupId))
  const badUsers = (picks.userIds ?? []).filter((id) => !people.has(id))
  const badTeams = (picks.teamIds ?? []).filter((id) => !teams.has(id))
  if (badUsers.length === 0 && badTeams.length === 0) return null
  return "grants may only name people and teams on this project's other lanes"
}

/** Give the new lane to the picked people and teams. Validate the picks first. */
export async function applyNewLaneGrants(
  db: AquillaDb,
  projectId: string,
  laneId: string,
  candidates: NewLaneGrantCandidates,
  picks: NewLaneGrantPicks,
  grantedBy: number,
): Promise<void> {
  const byUser = new Map(candidates.people.map((p) => [p.userId, p]))
  for (const userId of new Set(picks.userIds ?? [])) {
    const person = byUser.get(userId)
    if (!person) continue
    await db
      .prepare(
        `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
      )
      .bind(projectId, userId, laneId, person.roleLevel, grantedBy)
      .run()
    // A member whose lanes are stored as scopes keeps that list matching the
    // grants, or the next re-plan from scopes would drop the new lane.
    await db
      .prepare(
        `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
         SELECT ?, ?, 'lane', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM project_member_scopes s
                         WHERE s.project_id = ? AND s.user_id = ? AND s.kind = 'lane')
         ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
      )
      .bind(projectId, userId, laneId, String(grantedBy), Date.now(), projectId, userId)
      .run()
  }
  const teamIds = [...new Set(picks.teamIds ?? [])].filter((id) => candidates.teams.some((t) => t.groupId === id))
  if (teamIds.length > 0) {
    // Only the link statement: the roster is reconciled in TS below, which is
    // the same path every other team-lane change takes.
    const [link] = linkTeamsToLaneStmts(db, projectId, laneId, { groupIds: teamIds }, grantedBy)
    await link!.run()
    for (const groupId of teamIds) await applyTeamRosterLaneChecks(db, groupId, projectId, grantedBy)
  }
}
