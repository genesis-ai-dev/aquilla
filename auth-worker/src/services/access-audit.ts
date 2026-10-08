/**
 * AQU-1072 — access audit for an organization's Owners and Maintainers.
 *
 * Effective project roles are whatever `resolveProjectRoles` returns. That is
 * the same max-wins resolver enforcement uses (direct, team, org, creator,
 * platform). This file lists people, the teams they belong to, and the lane
 * grant rows already stored for them. It does not decide a role.
 */

import { loadLaneGrantsForProjects } from "../../../db/shared/lane-visibility"
import { resolveProjectRoles } from "./project-permissions"
import type { AuthUser, Env, RoleResolution } from "../types"

export interface AccessAuditLane {
  laneId: string
  name: string
  roleLevel: number
}

export interface AccessAuditProject {
  projectId: string
  projectName: string
  /** Winning role from resolveProjectRoles, including its source. */
  role: RoleResolution
  lanes: AccessAuditLane[]
}

export interface AccessAuditTeam {
  teamId: string
  name: string
  /** Team-membership role when one is stored. Null is a legacy membership. */
  roleLevel: number | null
}

export interface AccessAuditPerson {
  userId: string
  username: string
  displayName: string
  /** Null when the person can reach a project without being an org member. */
  orgRole: number | null
  teams: AccessAuditTeam[]
  projects: AccessAuditProject[]
}

export interface AccessAuditReport {
  orgId: number
  orgName: string
  generatedAt: string
  people: AccessAuditPerson[]
}

interface PersonRow {
  id: number | string
  username: string
  email: string | null
  display_name: string
  org_role: number | string | null
}

interface TeamRow {
  user_id: number | string
  team_id: number | string
  name: string
  role_level: number | string | null
}

interface ProjectRow {
  id: string
  name: string
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Enough of an AuthUser for resolveProjectRoles: it reads id and email. */
function asAuditUser(row: PersonRow): AuthUser {
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email ?? "",
    password_hash: "",
    preferences: {},
    created_at: "",
    updated_at: "",
    password_changed_at: null,
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return out
}

async function laneNames(env: Env, projectIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (projectIds.length === 0) return names
  const marks = projectIds.map(() => "?").join(", ")
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT id, name FROM lanes WHERE project_id IN (${marks})`,
  )
    .bind(...projectIds)
    .all<{ id: string; name: string | null }>()
  for (const row of results ?? []) {
    const name = row.name?.trim()
    if (name) names.set(row.id, name)
  }
  return names
}

/**
 * The report, or null when the organization does not exist. Caller must
 * already be an Owner or Maintainer (or a platform operator, who resolves
 * as owner).
 */
export async function buildAccessAudit(env: Env, orgId: number): Promise<AccessAuditReport | null> {
  const org = await env.AQUILLA_PG.prepare("SELECT id, name FROM organizations WHERE id = ?")
    .bind(orgId)
    .first<{ id: number | string; name: string }>()
  if (!org) return null

  const [peopleRes, teamRes, projectRes] = await Promise.all([
    env.AQUILLA_PG.prepare(
      `SELECT u.id AS id, u.username AS username, u.email AS email,
              COALESCE(NULLIF(TRIM(u.display_name), ''), u.username) AS display_name,
              om.role_level AS org_role
         FROM users u
         LEFT JOIN org_members om ON om.user_id = u.id AND om.org_id = ?
        WHERE u.id IN (
          SELECT user_id FROM org_members WHERE org_id = ?
          UNION
          SELECT pm.user_id FROM project_members pm
            JOIN projects p ON p.id = pm.project_id
           WHERE p.org_id = ? AND p.archived_at IS NULL
          UNION
          SELECT gm.user_id FROM group_members gm
            JOIN groups g ON g.id = gm.group_id
           WHERE g.org_id = ?
          UNION
          SELECT created_by FROM projects
           WHERE org_id = ? AND archived_at IS NULL AND created_by IS NOT NULL
        )`,
    )
      .bind(orgId, orgId, orgId, orgId, orgId)
      .all<PersonRow>(),
    env.AQUILLA_PG.prepare(
      `SELECT gm.user_id AS user_id, g.id AS team_id, g.name AS name, gm.role_level AS role_level
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
        WHERE g.org_id = ?`,
    )
      .bind(orgId)
      .all<TeamRow>(),
    env.AQUILLA_PG.prepare(
      `SELECT id, name FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY name`,
    )
      .bind(orgId)
      .all<ProjectRow>(),
  ])

  const projects = projectRes.results ?? []
  const projectIds = projects.map((p) => p.id)
  const names = await laneNames(env, projectIds)
  const teamsByUser = new Map<string, AccessAuditTeam[]>()
  for (const row of teamRes.results ?? []) {
    const key = String(row.user_id)
    const list = teamsByUser.get(key) ?? []
    list.push({
      teamId: String(row.team_id),
      name: row.name,
      roleLevel: asNumber(row.role_level),
    })
    teamsByUser.set(key, list)
  }
  for (const list of teamsByUser.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId))
  }

  const people = await mapPool(peopleRes.results ?? [], 8, async (row) => {
    const userId = String(row.id)
    const roles = await resolveProjectRoles(env, asAuditUser(row), projectIds)
    const accessible = projects.filter((project) => roles.get(project.id) != null)
    const grants = await loadLaneGrantsForProjects(
      env.AQUILLA_PG,
      Number(row.id),
      accessible.map((project) => project.id),
    )
    const audited: AccessAuditProject[] = accessible.map((project) => {
      const role = roles.get(project.id)!
      const lanes = (grants.get(project.id) ?? [])
        .map((grant): AccessAuditLane => ({
          laneId: grant.lane,
          name: names.get(grant.lane) ?? grant.lane,
          roleLevel: grant.level,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.laneId.localeCompare(b.laneId))
      return { projectId: project.id, projectName: project.name, role, lanes }
    })
    audited.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId))
    return {
      userId,
      username: row.username,
      displayName: row.display_name,
      orgRole: asNumber(row.org_role),
      teams: teamsByUser.get(userId) ?? [],
      projects: audited,
    } satisfies AccessAuditPerson
  })

  people.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.username.localeCompare(b.username))
  return {
    orgId: Number(org.id),
    orgName: org.name,
    generatedAt: new Date().toISOString(),
    people,
  }
}
