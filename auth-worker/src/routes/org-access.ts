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
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
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
  type PlaceGrant,
} from "../services/org-access-places"
import { assembleOrgPeople, type OrgAccessPerson } from "../services/org-access-people"
import { grantableMap, previewGrant, type GrantTarget } from "../services/grant-preview"
import { loadGrantTarget, loadGrantWorld } from "../services/grant-preview-load"
import type { PlaceGrantability } from "../../../src/lib/access/grant-rules"
import type { Env } from "../types"

export type { AccessTreeNode, DirectGrantee, OrgAccessPerson }
export interface OrgAccessPayload {
  tree: AccessTreeNode[]
  people: OrgAccessPerson[]
  /** AQU-2320: per place (`type:id`), may this viewer give access there, and up to which role. */
  grantable: Record<string, PlaceGrantability>
}

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

export async function buildOrgAccess(
  env: Env,
  vs: ViewerScope,
  orgId: number,
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
  const grantable = grantableMap(
    tree,
    { userId: String(vs.viewer.id), orgRole: await vs.orgRole(orgId), projectRoles: viewerProjectRole },
    extras.attachments,
  )
  return { ok: true, payload: { tree, people: list, grantable } }
}

const orgAccess = new Hono<AuthHonoEnv>()

/**
 * AQU-2320: POST /api/v2/orgs/:orgId/access/preview — the Give access dry
 * run. Writes nothing. 200 `{ preview }`; a grant this viewer could not make
 * is refused with `{ error, code, place, roleLevel, cap }` (the message names
 * the place, the role and the cap); a place or person outside what the
 * Places / People lenses show this viewer is 404.
 */
const previewBody = z.object({
  place: z.object({ type: z.enum(["org", "team", "project", "lane"]), id: z.string().min(1).max(256) }),
  roleLevel: z.number().int(),
  person: z.union([
    z.object({ userId: z.string().regex(/^\d{1,18}$/) }),
    z.object({ email: z.string().trim().toLowerCase().email().max(320) }),
  ]),
})

orgAccess.post("/:orgId/access/preview", authMiddleware, zValidator("json", previewBody), async (c) => {
  const orgId = Number(c.req.param("orgId"))
  if (!Number.isSafeInteger(orgId) || orgId <= 0) return c.json({ error: "bad org id" }, 400)
  const vs = new ViewerScope(c.env, c.get("user"))
  // One answer for every "not yours to ask about": an org this viewer sees
  // nothing of (or that does not exist), a place their Places lens does not
  // show, a person their People lens does not show. Identical to the GET's
  // 403, so none of the three can be told apart or used to enumerate.
  const hidden = () => c.json({ error: "no access to this roster" }, 403)
  // The lenses' own visibility rule, reused rather than restated: the place
  // must be a node of this viewer's tree (grantable carries one key per node,
  // lanes after the read wall), the person a row of this viewer's roster.
  const access = await buildOrgAccess(c.env, vs, orgId)
  if (!access.ok) return hidden()
  const body = c.req.valid("json")
  if (!(`${body.place.type}:${body.place.id}` in access.payload.grantable)) return hidden()
  const loaded = await loadGrantWorld(c.env, vs, orgId)
  if (!loaded) return hidden()
  let target: GrantTarget
  if ("email" in body.person) {
    target = { kind: "invite", email: body.person.email }
  } else {
    const userId = body.person.userId
    if (!access.payload.people.some((p) => p.userId === userId && !p.pendingInvite)) return hidden()
    const account = await loadGrantTarget(c.env, orgId, Number(userId))
    if (!account) return hidden()
    target = account
  }
  const result = previewGrant(loaded.world, loaded.granter, target, { place: body.place, roleLevel: body.roleLevel })
  if (result.ok) return c.json({ preview: result.preview })
  if ("notFound" in result) return hidden()
  const { status, message, ...rest } = result.refusal
  return c.json({ error: message, ...rest }, status)
})

orgAccess.get("/:orgId/access", authMiddleware, async (c) => {
  const orgId = Number(c.req.param("orgId"))
  if (!Number.isSafeInteger(orgId) || orgId <= 0) return c.json({ error: "bad org id" }, 400)
  const result = await buildOrgAccess(c.env, new ViewerScope(c.env, c.get("user")), orgId)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.payload)
})

function isoTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export default orgAccess
