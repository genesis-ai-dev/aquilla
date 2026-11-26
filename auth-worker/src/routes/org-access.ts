/**
 * AQU-1352 (spec §3.6, AQU-1072): GET /api/v2/orgs/:orgId/access — the
 * "People & access" page. Two projections of the same access_grants rows:
 *   tree   — places the viewer can see, each with direct grants and the
 *            ancestor grants that resolve there (AQU-2318);
 *   people — one row per member, guest, or pending invite the viewer may
 *            see, with every grant inside those places (AQU-2319).
 * Viewer filtering reuses services/access-payload.ts (ViewerScope/visibleTo,
 * spec §3.8 rule 4) so this page and the member inspector cannot disagree.
 */

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  ViewerScope,
  nameGranters,
  toNamedGrant,
  visibleTo,
  type NamedGrant,
  type NamedGrantRow,
} from "../services/access-payload"
import {
  assembleAccessTree,
  loadPlaceExtras,
  redactUnseenPlaces,
  type AccessTreeNode,
  type DirectGrantee,
  type PlaceExtras,
  type PlaceGrant,
} from "../services/org-access-places"
import { assembleOrgPeople, type OrgAccessPerson } from "../services/org-access-people"
import { hasActiveElevation, isPlatformAdminEmail } from "../middleware/platform-admin"
import { getOrgMemberRole } from "../services/org-permissions"
import { resolveProjectRole } from "../services/project-permissions"
import { INVITE_MIN_ROLE, ROLE, type Env } from "../types"

export type { AccessTreeNode, DirectGrantee, OrgAccessPerson }
export interface OrgAccessPayload { tree: AccessTreeNode[]; people: OrgAccessPerson[] }

type Row = NamedGrantRow & { user_id: number | string; user_name: string; user_email: string | null }

async function loadOrgGrants(env: Env, orgId: number): Promise<(PlaceGrant & NamedGrant)[]> {
  // SWARM-TODO(AQU-1352): scans the whole view then filters by org; add an
  // org-scoped predicate pushdown if this shows up in Hyperdrive timings.
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT x.*, o.name AS org_name,
            u.username AS user_name, u.email AS user_email FROM (
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
  return (results ?? []).map((r) => ({
    ...toNamedGrant(r),
    userId: String(r.user_id),
    userName: r.user_name,
    email: r.user_email,
  }))
}

/**
 * Pending invites appear only where the viewer could list them anyway, through
 * the same gates as GET /orgs/:id/invites (owner) and GET /projects/:id/invites
 * (Project lead). Platform-admin power counts only while elevated, as there.
 * Seeing a roster is not enough: the roster floor can sit far below these.
 */
async function keepListableInvites(
  env: Env,
  vs: ViewerScope,
  orgId: number,
  isElevated: () => Promise<boolean>,
  extras: PlaceExtras,
): Promise<void> {
  if (extras.orgInvites.length > 0) {
    const membership = (await getOrgMemberRole(env, orgId, vs.viewer.id)) ?? 0
    const ownsOrg = membership >= ROLE.OWNER
      || ((await isPlatformAdminEmail(env, vs.viewer.email)) && (await isElevated()))
    if (!ownsOrg) extras.orgInvites = []
  }
  for (const projectId of [...extras.projectInvites.keys()]) {
    const role = await resolveProjectRole(env, vs.viewer, projectId)
    const leads = role != null && role.level >= INVITE_MIN_ROLE
      && (role.source !== "platform" || (await isElevated()))
    if (!leads) extras.projectInvites.delete(projectId)
  }
}

export async function buildOrgAccess(
  env: Env,
  vs: ViewerScope,
  orgId: number,
  isElevated: () => Promise<boolean>,
): Promise<{ ok: true; payload: OrgAccessPayload } | { ok: false; status: 403; error: string }> {
  const org = await env.AQUILLA_PG.prepare("SELECT id, name FROM organizations WHERE id = ?")
    .bind(orgId).first<{ id: number; name: string }>()
  // Same 403 as "exists but not visible" so org ids cannot be enumerated.
  if (!org) return { ok: false, status: 403, error: "no access to this roster" }

  const [teamsRes, projectsRes, grants, membersRes] = await Promise.all([
    env.AQUILLA_PG.prepare("SELECT id, name FROM groups WHERE org_id = ? ORDER BY name")
      .bind(orgId).all<{ id: number | string; name: string }>(),
    env.AQUILLA_PG.prepare("SELECT id, name FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY name")
      .bind(orgId).all<{ id: string; name: string }>(),
    loadOrgGrants(env, orgId),
    env.AQUILLA_PG.prepare("SELECT user_id, last_active_at FROM org_members WHERE org_id = ?")
      .bind(orgId).all<{ user_id: number | string; last_active_at: string | Date | null }>(),
  ])

  const seesOrg = await vs.canSeeOrg(orgId)
  const visibleProjects = new Set<string>()
  for (const p of projectsRes.results ?? []) {
    if (await vs.canSeeProject(p.id, orgId)) visibleProjects.add(p.id)
  }
  if (!seesOrg && visibleProjects.size === 0) return { ok: false, status: 403, error: "no access to this roster" }

  const extras = await loadPlaceExtras(env, orgId, String(vs.viewer.id))
  await keepListableInvites(env, vs, orgId, isElevated, extras)
  const visible: typeof grants = []
  for (const g of grants) if (await visibleTo(vs, g)) visible.push(g)
  // A team the viewer belongs to is a place they can see even without the org
  // roster. Its own grants stay; every other team stays out of the payload.
  const treeGrants = [...visible]
  if (!seesOrg) {
    for (const g of grants) {
      if (g.scopeType === "team" && extras.viewerTeamIds.has(g.scopeId) && !visible.includes(g)) treeGrants.push(g)
    }
  }

  const viewerProjectRole = new Map<string, number | null>()
  for (const id of visibleProjects) viewerProjectRole.set(id, await vs.projectRole(id))
  const memberIds = new Set<string>()
  const lastActiveAt = new Map<string, string | null>()
  for (const row of membersRes.results ?? []) {
    const id = String(row.user_id)
    memberIds.add(id)
    lastActiveAt.set(id, isoTimestamp(row.last_active_at))
  }
  const { tree, visibleTeamIds } = assembleAccessTree({
    org: { type: "org", id: String(org.id), name: org.name },
    seesOrg,
    viewerId: String(vs.viewer.id),
    visibleProjectIds: visibleProjects,
    viewerProjectRole,
    wallFlag: env.LANE_READ_WALL,
    grants: treeGrants,
    teams: (teamsRes.results ?? []).map((t) => ({ id: String(t.id), name: t.name })),
    projects: projectsRes.results ?? [],
    memberIds,
    extras,
  })

  // treeGrants is `visible` plus team-scope rows on a team this viewer can see.
  // People outside those places are not added.
  const list = assembleOrgPeople({
    grants: treeGrants,
    memberIds,
    lastActiveAt,
    org: { type: "org", id: String(org.id), name: org.name },
    tree,
    extras,
  })
  // The org, and any team this viewer is not on, lose their names. A team they
  // can see keeps its name — hiding that too would contradict the tree.
  for (const entry of list.flatMap((p) => p.grants)) {
    entry.scopePath = redactUnseenPlaces(entry.scopePath, seesOrg, visibleTeamIds)
    if (entry.origin.from) entry.origin = { ...entry.origin, from: redactUnseenPlaces(entry.origin.from, seesOrg, visibleTeamIds) }
  }
  await nameGranters(env, list.flatMap((p) => p.grants))
  return { ok: true, payload: { tree, people: list } }
}

const orgAccess = new Hono<AuthHonoEnv>()

orgAccess.get("/:orgId/access", authMiddleware, async (c) => {
  const orgId = Number(c.req.param("orgId"))
  if (!Number.isSafeInteger(orgId) || orgId <= 0) return c.json({ error: "bad org id" }, 400)
  const result = await buildOrgAccess(c.env, new ViewerScope(c.env, c.get("user")), orgId, () => hasActiveElevation(c))
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.payload)
})

function isoTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export default orgAccess
