/**
 * AQU-1352 P2 (spec §3.1, §3.4, §3.5): team-scope roles on group_members.
 *
 * role_level NULL = legacy member (access only via per-project
 * group_project_grants). Non-NULL = a team-scope grant that flows to every
 * attached project (db/shared/access-grants.ts) and, at >= Project Lead,
 * lets the member create projects into the team.
 */
import { ROLE, type Env } from "../types"

/** Spec §3.4: the only roles a team scope carries. */
export const TEAM_SCOPE_ROLES: readonly number[] = [ROLE.MAINTAINER, ROLE.PROJECT_LEAD, ROLE.VIEWER]

/** Team role that may create projects into the team (spec D4). */
export const TEAM_CREATE_MIN_ROLE = ROLE.PROJECT_LEAD

/**
 * Role level used when a project created into a team attaches that team.
 * Matches the attach dialog's default in TeamDetail (ROLE.VIEWER); the attach
 * route itself takes the level from the client and has no server default.
 */
export const TEAM_ATTACH_DEFAULT_ROLE = ROLE.VIEWER

/** A group_members row: undefined = not a member, null = legacy member. */
export async function getTeamMemberRole(
  env: Env,
  groupId: number,
  userId: number,
): Promise<number | null | undefined> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT role_level FROM group_members WHERE group_id = ? AND user_id = ?",
  )
    .bind(groupId, userId)
    .first<{ role_level: number | null }>()
  if (!row) return undefined
  return row.role_level == null ? null : Number(row.role_level)
}

/** Sets the team-scope role. False when the user is not on the team. */
export async function setTeamMemberRole(
  env: Env,
  groupId: number,
  userId: number,
  roleLevel: number | null,
): Promise<boolean> {
  const row = await env.AQUILLA_PG.prepare(
    "UPDATE group_members SET role_level = ? WHERE group_id = ? AND user_id = ? RETURNING user_id",
  )
    .bind(roleLevel, groupId, userId)
    .first<{ user_id: number }>()
  return row != null
}

export interface CreatableTeam {
  orgId: number
  teamId: number
  name: string
  /** The caller's team role; null when the org role (>= 600) is what allows it. */
  role: number | null
}

/**
 * Teams the caller may create into. With org role >= 600 every team in the
 * org qualifies (same gate as the attach route); otherwise only teams where
 * the caller's team role is >= Project Lead.
 */
export async function listCreatableTeams(
  env: Env,
  userId: number,
  orgRoles: ReadonlyMap<number, number>,
): Promise<CreatableTeam[]> {
  const managed = [...orgRoles].filter(([, r]) => r >= ROLE.MAINTAINER).map(([id]) => id)
  const orgClause = managed.length ? ` OR g.org_id IN (${managed.map(() => "?").join(", ")})` : ""
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT g.org_id AS org_id, g.id AS id, g.name AS name, gm.role_level AS role
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      WHERE gm.role_level >= ?${orgClause}
      ORDER BY LOWER(g.name), g.id`,
  )
    .bind(userId, TEAM_CREATE_MIN_ROLE, ...managed)
    .all<{ org_id: number; id: number; name: string; role: number | null }>()
  const out: CreatableTeam[] = []
  for (const r of results ?? []) {
    const orgId = Number(r.org_id)
    const role = r.role == null ? null : Number(r.role)
    const orgRole = orgRoles.get(orgId) ?? 0
    if (orgRole >= ROLE.MAINTAINER || (role != null && role >= TEAM_CREATE_MIN_ROLE)) {
      out.push({ orgId, teamId: Number(r.id), name: r.name, role })
    }
  }
  return out
}

/** Teams by id that belong to orgId, with the caller's team role on each. */
export async function loadTeamsInOrg(
  env: Env,
  orgId: number,
  teamIds: readonly number[],
  userId: number,
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>()
  for (const teamId of teamIds) {
    const row = await env.AQUILLA_PG.prepare(
      `SELECT g.id AS id, gm.role_level AS role
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
        WHERE g.id = ? AND g.org_id = ?`,
    )
      .bind(userId, teamId, orgId)
      .first<{ id: number; role: number | null }>()
    if (row) out.set(teamId, row.role == null ? null : Number(row.role))
  }
  return out
}
