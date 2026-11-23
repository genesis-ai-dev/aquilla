/**
 * AQU-2320: the reads behind the Give access dry run. Everything here is
 * input for the pure functions in grant-preview.ts; nothing decides anything.
 *
 * Visibility follows GET /orgs/:id/access: projects through
 * ViewerScope.canSeeProject, teams when the viewer sees the org or is on the
 * team. A place outside that set is "not found", so the dry run cannot be
 * used to name a place, or a change at a place, the Places lens would hide.
 */
import type { AccessGrant, GrantScope, GrantSource } from "../../../db/shared/access-grants"
import { laneDisplayNameSql } from "../../../db/shared/lanes"
import type { Env } from "../types"
import type { ViewerScope } from "./access-payload"
import type { Granter, GrantTarget, OrgWorld } from "./grant-preview"

export async function loadGrantWorld(env: Env, vs: ViewerScope, orgId: number): Promise<{ world: OrgWorld; granter: Granter } | null> {
  const org = await env.AQUILLA_PG.prepare("SELECT id, name FROM organizations WHERE id = ?")
    .bind(orgId).first<{ id: number | string; name: string }>()
  if (!org) return null
  const viewerId = String(vs.viewer.id)
  const [teamsRes, projectsRes, attachRes, viewerTeamsRes] = await Promise.all([
    env.AQUILLA_PG.prepare("SELECT id, name FROM groups WHERE org_id = ? ORDER BY name")
      .bind(orgId).all<{ id: number | string; name: string }>(),
    env.AQUILLA_PG.prepare("SELECT id, name FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY name")
      .bind(orgId).all<{ id: string; name: string }>(),
    env.AQUILLA_PG.prepare(
      `SELECT gpg.group_id AS group_id, gpg.project_id AS project_id, gpg.role_level AS role_level
         FROM group_project_grants gpg
         JOIN groups g ON g.id = gpg.group_id
        WHERE g.org_id = ?`,
    ).bind(orgId).all<{ group_id: number | string; project_id: string; role_level: number }>(),
    env.AQUILLA_PG.prepare(
      `SELECT gm.group_id AS group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE g.org_id = ? AND gm.user_id = ?`,
    ).bind(orgId, viewerId).all<{ group_id: number | string }>(),
  ])

  const seesOrg = await vs.canSeeOrg(orgId)
  const projects: OrgWorld["projects"] = []
  const projectRoles = new Map<string, number | null>()
  for (const p of projectsRes.results ?? []) {
    if (!(await vs.canSeeProject(p.id, orgId))) continue
    projects.push({ id: p.id, name: p.name })
    projectRoles.set(p.id, await vs.projectRole(p.id))
  }
  const viewerTeams = new Set((viewerTeamsRes.results ?? []).map((r) => String(r.group_id)))
  const teams = (teamsRes.results ?? [])
    .map((t) => ({ id: String(t.id), name: t.name }))
    .filter((t) => seesOrg || viewerTeams.has(t.id))

  const lanes: OrgWorld["lanes"] = []
  if (projects.length > 0) {
    const marks = projects.map(() => "?").join(", ")
    const { results } = await env.AQUILLA_PG.prepare(
      `SELECT l.id AS id, l.project_id AS project_id, ${laneDisplayNameSql("l")} AS name
         FROM lanes l
        WHERE l.project_id IN (${marks}) AND l.archived_at IS NULL AND l.role = 'target'
        ORDER BY l.position, name`,
    ).bind(...projects.map((p) => p.id)).all<{ id: string; project_id: string; name: string }>()
    for (const row of results ?? []) lanes.push({ id: row.id, projectId: row.project_id, name: row.name })
  }

  return {
    world: {
      org: { type: "org", id: String(org.id), name: org.name },
      teams,
      projects,
      lanes,
      attachments: (attachRes.results ?? []).map((a) => ({
        teamId: String(a.group_id),
        projectId: a.project_id,
        roleLevel: Number(a.role_level),
      })),
    },
    granter: { userId: viewerId, orgRole: await vs.orgRole(orgId), projectRoles },
  }
}

interface GrantRow {
  scope_type: GrantScope
  scope_id: string
  role_level: number
  source: GrantSource
  via_team_id: number | string | null
}

/**
 * The person being granted, as the resolver sees them inside this org. Null
 * when they hold nothing here at all: the dialog only offers the org's own
 * people (members, and guests who already hold a grant), so anyone else is
 * not a person this org's dry run answers about.
 */
export async function loadGrantTarget(env: Env, orgId: number, userId: number): Promise<Extract<GrantTarget, { kind: "account" }> | null> {
  const user = await env.AQUILLA_PG.prepare("SELECT id, username FROM users WHERE id = ?")
    .bind(userId).first<{ id: number | string; username: string }>()
  if (!user) return null
  const [memberRow, grantsRes, laneRes] = await Promise.all([
    env.AQUILLA_PG.prepare("SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(orgId, userId).first<{ role_level: number }>(),
    // Same org predicate as GET /orgs/:id/access (routes/org-access.ts loadOrgGrants), for one person.
    env.AQUILLA_PG.prepare(
      `SELECT g.scope_type, g.scope_id, g.role_level, g.source, g.via_team_id
         FROM access_grants g
         LEFT JOIN projects p ON g.scope_type = 'project' AND p.id = g.scope_id
         LEFT JOIN groups t ON g.scope_type = 'team' AND t.id::TEXT = g.scope_id
        WHERE g.user_id = ?
          AND (g.scope_type <> 'project' OR p.archived_at IS NULL)
          AND COALESCE(CASE WHEN g.scope_type = 'org' THEN g.scope_id::BIGINT END, p.org_id, t.org_id) = ?`,
    ).bind(userId, orgId).all<GrantRow>(),
    env.AQUILLA_PG.prepare(
      `SELECT r.project_id AS project_id, r.lane AS lane, r.role_level AS role_level
         FROM project_member_lane_roles r
         JOIN projects p ON p.id = r.project_id
        WHERE r.user_id = ? AND p.org_id = ? AND p.archived_at IS NULL`,
    ).bind(userId, orgId).all<{ project_id: string; lane: string; role_level: number }>(),
  ])
  const grants: AccessGrant[] = (grantsRes.results ?? []).map((r) => ({
    userId: String(userId),
    scopeType: r.scope_type,
    scopeId: String(r.scope_id),
    roleLevel: Number(r.role_level),
    source: r.source,
    viaTeamId: r.via_team_id == null ? null : String(r.via_team_id),
    grantedBy: null,
    grantedAt: null,
  }))
  const laneGrants = (laneRes.results ?? []).map((r) => ({ projectId: r.project_id, laneId: r.lane, roleLevel: Number(r.role_level) }))
  const isOrgMember = memberRow != null
  if (!isOrgMember && grants.length === 0 && laneGrants.length === 0) return null
  return { kind: "account", userId: String(userId), displayName: user.username, isOrgMember, grants, laneGrants }
}
