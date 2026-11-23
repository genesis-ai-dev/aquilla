/**
 * AQU-2322: lane grants written from the access page.
 *
 *   PUT    /api/v2/orgs/:orgId/access/lane-grant  { laneId, userId, roleLevel }
 *          Give, or change the role of, one lane grant. 200
 *          `{ granted: { userId, projectId, laneId, roleLevel, newMembership } }`.
 *   DELETE /api/v2/orgs/:orgId/access/lane-grant  { laneId, userId }
 *          Remove one lane grant. 200 `{ removed: true, endedMembership }`.
 *
 * The additive lane-grants path: each call writes or deletes exactly one
 * project_member_lane_roles row and leaves the person's other lanes alone. It
 * never writes project_member_scopes, the restrictive table lane staffing
 * (PUT /projects/:p/members/:u/scopes) replaces wholesale. Two cases touch the
 * membership, and only these:
 *   - someone the project does not open yet gets the project_members row that
 *     opens it, at the lane role, starting clean the way a fresh membership
 *     does on POST /projects/:p/members (AQU-1808: no lane rows or lane scopes
 *     of an earlier membership survive);
 *   - removing the last lane grant of someone whose only way in is lane grants
 *     removes that row too, exactly as DELETE /projects/:p/members/:u does,
 *     and ejects their live sessions when nothing else opens the project.
 *
 * Every call is decided by the same dry run the dialogs show (previewGrant /
 * previewRemoval, with the caps in src/lib/access/grant-rules.ts), behind the
 * same visibility gate as the dry runs: the lane must be a node of this
 * viewer's Places lens and the person a row of their People lens, and every
 * miss is the one identical 403. Platform-admin power needs elevation, as on
 * every membership write (AQU-1322).
 */
import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ViewerScope } from "../services/access-payload"
import { auditMembershipChange } from "../services/admin-audit"
import { projectElevationDenial } from "../services/elevation-gate"
import { previewGrant, resolveAt, type GrantTarget, type Granter, type OrgWorld } from "../services/grant-preview"
import { loadGrantTarget, loadGrantWorld, withLaneView } from "../services/grant-preview-load"
import { reconcileMemberProjectLanes, replaceMemberLaneScopes } from "../services/lane-grants"
import { forgetProjectRole, resolveProjectRole } from "../services/project-permissions"
import { previewRemoval } from "../services/removal-preview"
import { notifySyncWorkerOfMemberRemoval, notifySyncWorkerOfMemberRoleChange } from "../services/sync-worker-notify"
import type { AuthUser } from "../types"
import { buildOrgAccess } from "./org-access"

const laneGrantRoutes = new Hono<AuthHonoEnv>()

const laneId = z.string().min(1).max(256)
const userId = z.string().regex(/^\d{1,18}$/)
const putBody = z.object({ laneId, userId, roleLevel: z.number().int() })
const deleteBody = z.object({ laneId, userId })

type Gated = {
  world: OrgWorld
  granter: Granter
  target: Extract<GrantTarget, { kind: "account" }>
  projectId: string
}

/** The dry runs' visibility gate, then the elevation rule. A Response is the answer to send. */
async function gate(c: Context<AuthHonoEnv>, laneIdValue: string, userIdValue: string): Promise<Gated | Response> {
  const orgId = Number(c.req.param("orgId"))
  if (!Number.isSafeInteger(orgId) || orgId <= 0) return c.json({ error: "bad org id" }, 400)
  const user = c.get("user")
  const vs = new ViewerScope(c.env, user)
  const hidden = () => c.json({ error: "no access to this roster" }, 403)
  const access = await buildOrgAccess(c.env, vs, orgId)
  if (!access.ok) return hidden()
  const { grantable, people } = access.payload
  if (!(`lane:${laneIdValue}` in grantable)) return hidden()
  if (!people.some((p) => p.userId === userIdValue && !p.pendingInvite)) return hidden()
  const loaded = await loadGrantWorld(c.env, vs, orgId)
  if (!loaded) return hidden()
  const world = withLaneView(loaded.world, grantable, c.env.LANE_READ_WALL)
  const lane = world.lanes.find((l) => l.id === laneIdValue)
  if (!lane) return hidden()
  const target = await loadGrantTarget(c.env, orgId, Number(userIdValue))
  if (!target) return hidden()
  const callerRole = await resolveProjectRole(c.env, user, lane.projectId)
  if (!callerRole) return hidden()
  const unelevated = await projectElevationDenial(c, callerRole)
  if (unelevated) return unelevated
  return { world, granter: loaded.granter, target, projectId: lane.projectId }
}

/** waitUntil exists only with a real ExecutionContext; the test harness has none. */
function settle(c: Context<AuthHonoEnv>, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise)
  } catch {
    void promise
  }
}

laneGrantRoutes.put("/:orgId/access/lane-grant", authMiddleware, zValidator("json", putBody), async (c) => {
  const body = c.req.valid("json")
  const gated = await gate(c, body.laneId, body.userId)
  if (gated instanceof Response) return gated
  const { world, granter, target, projectId } = gated
  const result = previewGrant(world, granter, target, { place: { type: "lane", id: body.laneId }, roleLevel: body.roleLevel })
  if (!result.ok) {
    if ("notFound" in result) return c.json({ error: "no access to this roster" }, 403)
    const { status, message, ...rest } = result.refusal
    return c.json({ error: message, ...rest }, status)
  }

  const user = c.get("user")
  const db = c.env.AQUILLA_PG
  const uid = Number(body.userId)
  const newMembership = resolveAt(world, target.grants, projectId) == null
  if (newMembership) {
    await db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
      )
      .bind(projectId, uid, body.roleLevel, user.id)
      .run()
    // A fresh membership starts clean (AQU-1808): an earlier membership's lane
    // rows and lane scopes would otherwise decide which lanes this one opens.
    await db.prepare("DELETE FROM project_member_lane_roles WHERE project_id = ? AND user_id = ?").bind(projectId, uid).run()
    await replaceMemberLaneScopes(db, projectId, uid, [], user.id)
  }
  await db
    .prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id, lane) DO UPDATE SET
         role_level = excluded.role_level,
         granted_by = excluded.granted_by,
         granted_at = now()`,
    )
    .bind(projectId, uid, body.laneId, body.roleLevel, user.id)
    .run()
  if (newMembership) {
    await auditMembershipChange(c.env, user, {
      action: "project.member.grant",
      where: { scope: "project", projectId },
      target: { id: uid, username: target.displayName },
      roleBefore: null,
      roleAfter: body.roleLevel,
    })
    settle(c, notifySyncWorkerOfMemberRoleChange(c.env, projectId, { userId: uid, username: target.displayName, role: body.roleLevel }))
  }
  return c.json({ granted: { userId: body.userId, projectId, laneId: body.laneId, roleLevel: body.roleLevel, newMembership } })
})

laneGrantRoutes.delete("/:orgId/access/lane-grant", authMiddleware, zValidator("json", deleteBody), async (c) => {
  const body = c.req.valid("json")
  const gated = await gate(c, body.laneId, body.userId)
  if (gated instanceof Response) return gated
  const { world, granter, target, projectId } = gated
  const result = previewRemoval(world, granter, target, [{ type: "lane", id: body.laneId }])
  if (!result.ok) {
    if ("notFound" in result) return c.json({ error: "no access to this roster" }, 403)
    const { status, message, ...rest } = result.refusal
    return c.json({ error: message, ...rest }, status)
  }

  const user = c.get("user")
  const db = c.env.AQUILLA_PG
  const uid = Number(body.userId)
  await db
    .prepare("DELETE FROM project_member_lane_roles WHERE project_id = ? AND user_id = ? AND lane = ?")
    .bind(projectId, uid, body.laneId)
    .run()
  const ending = result.preview.removes.find((r) => r.withLastLane)
  if (ending) await endMembership(c, user, projectId, uid, ending.roleLevel)
  return c.json({ removed: true, endedMembership: ending != null })
})

/** DELETE /projects/:p/members/:u's write, for the membership a last lane grant opened. */
async function endMembership(c: Context<AuthHonoEnv>, user: AuthUser, projectId: string, uid: number, roleBefore: number | null): Promise<void> {
  const db = c.env.AQUILLA_PG
  await db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, uid).run()
  forgetProjectRole(c.env, projectId, uid)
  // AQU-1818: a team that still reaches them keeps that team's lanes; otherwise the rows go.
  await reconcileMemberProjectLanes(db, projectId, uid, user.id)
  const targetUser = await db.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first<AuthUser>()
  await auditMembershipChange(c.env, user, {
    action: "project.member.remove",
    where: { scope: "project", projectId },
    target: { id: uid, username: targetUser?.username },
    roleBefore,
    roleAfter: null,
  })
  forgetProjectRole(c.env, projectId, uid)
  const surviving = targetUser ? await resolveProjectRole(c.env, targetUser, projectId) : null
  if (!surviving) settle(c, notifySyncWorkerOfMemberRemoval(c.env, projectId, { userId: uid, username: targetUser?.username }))
}

export default laneGrantRoutes
