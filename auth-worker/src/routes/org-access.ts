/**
 * AQU-1352 (spec §3.6, AQU-1072): GET /api/v2/orgs/:orgId/access — the
 * "People & access" page. Two projections of the same access_grants rows:
 *   tree   — org › teams › projects, each node listing its direct grantees;
 *   people — one row per person with every grant the viewer may see.
 * Viewer filtering reuses services/access-payload.ts (ViewerScope/visibleTo,
 * spec §3.8 rule 4) so this page and the member inspector cannot disagree.
 */

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  ViewerScope,
  hideUnseenAncestors,
  nameGranters,
  toEntry,
  toNamedGrant,
  visibleTo,
  type AccessChainEntry,
  type NamedGrant,
  type NamedGrantRow,
  type ScopeRef,
} from "../services/access-payload"
import type { Env } from "../types"

export interface DirectGrantee { userId: string; displayName: string; roleLevel: number }
export interface AccessTreeNode { scope: ScopeRef; children: AccessTreeNode[]; directGrantees: DirectGrantee[] }
export interface OrgAccessPerson { userId: string; displayName: string; isGuest: boolean; grants: AccessChainEntry[] }
export interface OrgAccessPayload { tree: AccessTreeNode[]; people: OrgAccessPerson[] }

type Row = NamedGrantRow & { user_id: number | string; user_name: string }

async function loadOrgGrants(env: Env, orgId: number): Promise<(NamedGrant & { userId: string; userName: string })[]> {
  // SWARM-TODO(AQU-1352): scans the whole view then filters by org; add an
  // org-scoped predicate pushdown if this shows up in Hyperdrive timings.
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT x.*, o.name AS org_name,
            u.username AS user_name FROM (
       SELECT g.user_id, g.scope_type, g.scope_id, g.role_level, g.source, g.via_team_id,
              g.granted_by, g.granted_at,
              COALESCE(CASE WHEN g.scope_type = 'org' THEN g.scope_id::BIGINT END,
                       p.org_id, t.org_id) AS org_id,
              t.id AS team_id, t.name AS team_name, p.name AS project_name
         FROM access_grants g
         LEFT JOIN projects p ON g.scope_type = 'project' AND p.id = g.scope_id
         LEFT JOIN groups t ON t.id = COALESCE(g.via_team_id,
              CASE WHEN g.scope_type = 'team' THEN g.scope_id::BIGINT END)
        WHERE (g.scope_type <> 'project' OR p.archived_at IS NULL)
     ) x
     JOIN users u ON u.id = x.user_id
     LEFT JOIN organizations o ON o.id = x.org_id
     WHERE x.org_id = ?`,
  )
    .bind(orgId)
    .all<Row>()
  return (results ?? []).map((r) => ({ ...toNamedGrant(r), userId: String(r.user_id), userName: r.user_name }))
}

export async function buildOrgAccess(
  env: Env,
  vs: ViewerScope,
  orgId: number,
): Promise<{ ok: true; payload: OrgAccessPayload } | { ok: false; status: 403; error: string }> {
  const org = await env.AQUILLA_PG.prepare("SELECT id, name FROM organizations WHERE id = ?")
    .bind(orgId).first<{ id: number; name: string }>()
  // Same 403 as "exists but not visible" so org ids cannot be enumerated.
  if (!org) return { ok: false, status: 403, error: "no access to this roster" }

  const [teamsRes, projectsRes, attachRes, grants] = await Promise.all([
    env.AQUILLA_PG.prepare("SELECT id, name FROM groups WHERE org_id = ? ORDER BY name")
      .bind(orgId).all<{ id: number | string; name: string }>(),
    env.AQUILLA_PG.prepare("SELECT id, name FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY name")
      .bind(orgId).all<{ id: string; name: string }>(),
    env.AQUILLA_PG.prepare(
      `SELECT gpg.group_id, gpg.project_id FROM group_project_grants gpg
         JOIN groups g ON g.id = gpg.group_id WHERE g.org_id = ?`,
    ).bind(orgId).all<{ group_id: number | string; project_id: string }>(),
    loadOrgGrants(env, orgId),
  ])

  const seesOrg = await vs.canSeeOrg(orgId)
  const visibleProjects = new Set<string>()
  for (const p of projectsRes.results ?? []) {
    if (await vs.canSeeProject(p.id, orgId)) visibleProjects.add(p.id)
  }
  if (!seesOrg && visibleProjects.size === 0) return { ok: false, status: 403, error: "no access to this roster" }

  const visible: typeof grants = []
  for (const g of grants) if (await visibleTo(vs, g)) visible.push(g)

  const grantee = (g: (typeof grants)[number]): DirectGrantee => ({ userId: g.userId, displayName: g.userName, roleLevel: g.roleLevel })
  const byName = (a: DirectGrantee, b: DirectGrantee) => a.displayName.localeCompare(b.displayName)
  // One entry per person per node: a creator usually also holds a direct row on
  // the same project, and both are project-scope grants. Keep the highest role;
  // the person view still lists every grant with its origin.
  const onePerPerson = (list: DirectGrantee[]): DirectGrantee[] => {
    const best = new Map<string, DirectGrantee>()
    for (const g of list) {
      const prev = best.get(g.userId)
      if (!prev || g.roleLevel > prev.roleLevel) best.set(g.userId, g)
    }
    return [...best.values()].sort(byName)
  }
  const orgRef: ScopeRef = { type: "org", id: String(org.id), name: org.name }

  const projectNode = (p: { id: string; name: string }): AccessTreeNode => ({
    scope: { type: "project", id: p.id, name: p.name },
    children: [],
    // Direct = the row lives on the project (direct or creator), not via a team.
    directGrantees: onePerPerson(visible
      .filter((g) => g.scopeType === "project" && g.scopeId === p.id && g.source !== "team")
      .map(grantee)),
  })
  const projects = (projectsRes.results ?? []).filter((p) => visibleProjects.has(p.id))
  const attached = new Map<string, string[]>()
  for (const a of attachRes.results ?? []) {
    const k = String(a.group_id)
    attached.set(k, [...(attached.get(k) ?? []), a.project_id])
  }

  let children: AccessTreeNode[]
  if (seesOrg) {
    const teamNodes = (teamsRes.results ?? []).map((t): AccessTreeNode => {
      const ids = new Set(attached.get(String(t.id)) ?? [])
      return {
        scope: { type: "team", id: String(t.id), name: t.name },
        children: projects.filter((p) => ids.has(p.id)).map(projectNode),
        directGrantees: onePerPerson(visible
          .filter((g) => (g.scopeType === "team" && g.scopeId === String(t.id)))
          .map(grantee)),
      }
    })
    const inTeam = new Set([...attached.values()].flat())
    children = [...teamNodes, ...projects.filter((p) => !inTeam.has(p.id)).map(projectNode)]
  } else {
    // Rule 4: without org-roster knowledge, team structure is not shown.
    children = projects.map(projectNode)
  }
  const tree: AccessTreeNode[] = [{
    scope: orgRef,
    children,
    directGrantees: onePerPerson(visible.filter((g) => g.scopeType === "org").map(grantee)),
  }]

  const people = new Map<string, OrgAccessPerson>()
  for (const g of visible) {
    const person = people.get(g.userId) ?? { userId: g.userId, displayName: g.userName, isGuest: true, grants: [] }
    person.grants.push(toEntry(g))
    people.set(g.userId, person)
  }
  // isGuest (rule 5) needs the org row even when the viewer cannot see it.
  const members = await env.AQUILLA_PG.prepare("SELECT user_id FROM org_members WHERE org_id = ?")
    .bind(orgId).all<{ user_id: number | string }>()
  const memberIds = new Set((members.results ?? []).map((m) => String(m.user_id)))
  for (const p of people.values()) p.isGuest = !memberIds.has(p.userId)

  const list = [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  // Rule 4: same crumb redaction as the member inspector.
  await hideUnseenAncestors(vs, list.flatMap((p) => p.grants))
  await nameGranters(env, list.flatMap((p) => p.grants))
  return { ok: true, payload: { tree, people: list } }
}

const orgAccess = new Hono<AuthHonoEnv>()

orgAccess.get("/:orgId/access", authMiddleware, async (c) => {
  const orgId = Number(c.req.param("orgId"))
  if (!Number.isSafeInteger(orgId) || orgId <= 0) return c.json({ error: "bad org id" }, 400)
  const result = await buildOrgAccess(c.env, new ViewerScope(c.env, c.get("user")), orgId)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.payload)
})

export default orgAccess
