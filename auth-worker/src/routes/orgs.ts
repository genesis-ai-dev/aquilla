// Organization routes. Ported from frontier-server's
// `cloudflare/src/routes/orgs.ts`. Personal-org lazy-create, members CRUD,
// member-project listing, and pending-invite listing.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { isPlatformAdminEmail } from "../middleware/platform-admin"
import { JWTService } from "../auth/jwt"
import { ROLE, type AuthUser, type Env } from "../types"
import {
  addGroupMember,
  attachGroupProject,
  bumpOrgActivity,
  canViewRoster,
  createGroup,
  createOrgForUser,
  deleteGroup,
  detachGroupProject,
  getEffectiveOrgRole,
  getMemberEffectiveAccess,
  getOrCreateUserOrg,
  getOrgGroupDetail,
  getOrgDeletedFiles,
  getOrgPortfolio,
  getOrgPortfolios,
  getRosterViewMinRole,
  groupExistsInOrg,
  listEffectiveMembersForOrg,
  listOrgGroups,
  listOrgMembersWithUsers,
  listPendingInvitesInOrg,
  listUserDirectMembershipsInOrg,
  listUserOrgs,
  removeGroupMember,
  renameOrg,
  updateGroup,
  updateGroupProjectRole,
} from "../services/org-permissions"
import {
  ALL_ROLE_LEVELS,
  isCanonicalRoleLevel,
  ROLE_NAMES,
} from "../services/project-permissions"
import { lookupUserByUsername } from "../services/user-lookup"
import { getOrgAssignmentWorkload, getMyAssignmentsAcrossOrg } from "../services/assignments"
import { sendOrgInviteEmail } from "../services/email"

const orgs = new Hono<AuthHonoEnv>()

/**
 * Compare two user ids that may arrive as a number or, from a Postgres BIGINT
 * column (e.g. org_invites.used_by), a string. Comparing across those types
 * with `===` silently fails, so a still-member redeemer re-clicking a used
 * invite would wrongly get a 410 instead of the continue-preview. Normalize
 * both sides before comparing.
 */
export function isSameUserId(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean {
  return a != null && b != null && String(a) === String(b)
}

// ──────────────────────────────────────────────────────────────────────────
// PUBLIC route — registered BEFORE the router-wide authMiddleware below so a
// signed-out invite recipient can see what they were invited to. Mirrors
// GET /api/v2/projects/invite-preview/:token: the token itself is the
// credential; the payload only names what accepting would already reveal.
// Everything registered after orgs.use("*") stays authed. (AQU-471)
// ──────────────────────────────────────────────────────────────────────────

/**
 * AQU-347: best-effort caller identity for the (otherwise public) preview
 * route. A missing/invalid/expired token is NOT an error here — it just means
 * "treat this preview as anonymous", so the route stays reachable for
 * signed-out visitors following a share link. Mirrors `optionalCaller` in
 * routes/invites.ts / routes/projects.ts.
 */
async function optionalCaller(env: Env, authHeader: string | null): Promise<AuthUser | null> {
  if (!authHeader) return null
  const jwtService = new JWTService(env)
  const token = jwtService.extractTokenFromHeader(authHeader)
  if (!token) return null
  const payload = await jwtService.verifyToken(token)
  if (!payload) return null
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp < now) return null
  return jwtService.getUserByUsername(payload.sub)
}

orgs.get("/invite-preview/:token", async (c) => {
  const token = c.req.param("token")
  if (!token || token.length < 8) {
    return c.json({ error: "Invalid token" }, 404)
  }

  const invite = await c.env.AQUILLA_PG.prepare(
    `SELECT token, org_id, role_level, created_by, created_at,
            expires_at, used_by, used_at, email
     FROM org_invites WHERE token = ?`,
  )
    .bind(token)
    .first<OrgInviteRow>()
  if (!invite) return c.json({ error: "Invite not found" }, 404)
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return c.json({ error: "Invite expired", code: "time_expired" }, 410)
  }
  // AQU-347: a used link isn't necessarily dead for THIS caller. If the
  // authenticated caller is the original redeemer (used_by) AND is still an
  // org member, re-clicking reads as "you're already in — continue" (a normal
  // 200 preview; accept-invite is an idempotent no-op for a still-member
  // redeemer). Everyone else (removed redeemer, a different user, anonymous)
  // still gets 410.
  if (invite.used_at) {
    const caller = await optionalCaller(c.env, c.req.header("Authorization") ?? null)
    const callerIsStillMemberRedeemer =
      caller != null &&
      isSameUserId(invite.used_by, caller.id) &&
      (await c.env.AQUILLA_PG.prepare(
        "SELECT 1 AS present FROM org_members WHERE org_id = ? AND user_id = ?",
      )
        .bind(invite.org_id, caller.id)
        .first()) != null
    if (!callerIsStillMemberRedeemer) {
      return c.json({ error: "Invite already used", code: "used" }, 410)
    }
  }

  const org = await c.env.AQUILLA_PG.prepare(
    "SELECT id, name FROM organizations WHERE id = ?",
  )
    .bind(invite.org_id)
    .first<{ id: number; name: string | null }>()
  if (!org) return c.json({ error: "Organization not found" }, 404)

  // Who invited you (AQU-471) — best-effort; null when the account is gone.
  const inviter = await c.env.AQUILLA_PG.prepare(
    "SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?",
  )
    .bind(invite.created_by)
    .first<{ name: string | null }>()

  return c.json({
    orgId: invite.org_id,
    orgName: org.name,
    invitedBy: inviter?.name ?? null,
    role: { level: invite.role_level, name: ROLE_NAMES[invite.role_level] ?? "unknown" },
    expiresAt: invite.expires_at,
    email: invite.email ?? null,
  })
})

orgs.use("*", authMiddleware)

/**
 * GET /api/v2/orgs — every org the caller belongs to (owned + member).
 * Platform operators additionally get every other org in the tenancy,
 * flagged `viaPlatformAdmin` and appended AFTER genuine memberships — the
 * SPA's default active org is the first entry, which must stay a real
 * membership so an admin's fresh session doesn't land in someone else's org.
 */
orgs.get("/", async (c) => {
  const user = c.get("user")
  const list = await listUserOrgs(c.env, user)
  const result: Array<{
    id: number
    name: string | null
    role: { level: number; name: string }
    viaPlatformAdmin?: boolean
  }> = list.map((o) => ({
    id: o.id,
    name: o.name,
    role: { level: o.role, name: ROLE_NAMES[o.role] ?? "unknown" },
  }))

  if (isPlatformAdminEmail(c.env, user.email)) {
    const memberIds = new Set(list.map((o) => o.id))
    const all = await c.env.AQUILLA_PG.prepare(
      "SELECT id, name FROM organizations ORDER BY LOWER(COALESCE(name, ''))",
    ).all<{ id: number; name: string | null }>()
    for (const o of all.results ?? []) {
      if (memberIds.has(o.id)) continue
      result.push({
        id: o.id,
        name: o.name,
        role: { level: 700, name: "admin" },
        viaPlatformAdmin: true,
      })
    }
  }

  return c.json({ orgs: result })
})

/** POST /api/v2/orgs — create a new named org; caller becomes owner. */
const createOrgBody = z.object({ name: z.string().min(1).max(200) })
orgs.post("/", zValidator("json", createOrgBody), async (c) => {
  const user = c.get("user")
  const { name } = c.req.valid("json")
  const org = await createOrgForUser(c.env, user, name)
  return c.json({ id: org.id, name: org.name, role: { level: 700, name: ROLE_NAMES[700] ?? "owner" } })
})

/** PATCH /api/v2/orgs/:orgId — rename the org (org role >= maintainer). */
const renameOrgBody = z.object({ name: z.string().min(1).max(200) })
orgs.patch("/:orgId", zValidator("json", renameOrgBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null || role < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  const { name } = c.req.valid("json")
  await renameOrg(c.env, orgId, name)
  return c.json({ id: orgId, name })
})

/** GET /api/v2/orgs/me — caller's owned organization (lazy-created). */
orgs.get("/me", async (c) => {
  const user = c.get("user")
  const org = await getOrCreateUserOrg(c.env, user)
  await bumpOrgActivity(c.env, user.id, org.id)
  return c.json({
    id: org.id,
    name: org.name,
    role: { level: org.role, name: ROLE_NAMES[org.role] ?? "owner" },
  })
})

const portfolioBatchBody = z.object({
  orgIds: z.array(z.number().int().positive()).max(100),
})

/** POST /api/v2/orgs/portfolio — batched per-project rollups for all-org views. */
orgs.post("/portfolio", zValidator("json", portfolioBatchBody), async (c) => {
  const user = c.get("user")
  const { orgIds } = c.req.valid("json")
  const uniqueOrgIds = [...new Set(orgIds)]
  if (uniqueOrgIds.length === 0) return c.json({ portfolios: [] })

  const isAdmin = isPlatformAdminEmail(c.env, user.email)
  if (!isAdmin) {
    const placeholders = uniqueOrgIds.map(() => "?").join(", ")
    const allowed = await c.env.AQUILLA_PG.prepare(
      `SELECT org_id FROM org_members WHERE user_id = ? AND org_id IN (${placeholders})`,
    ).bind(user.id, ...uniqueOrgIds).all<{ org_id: number }>()
    const allowedOrgIds = new Set((allowed.results ?? []).map((row) => row.org_id))
    if (uniqueOrgIds.some((orgId) => !allowedOrgIds.has(orgId))) {
      return c.json({ error: "not an org member" }, 403)
    }
  }

  // AQU-745: scope each org's rollup to the projects this caller can actually
  // see — a sub-maintainer member must not enumerate every project name in the
  // org via the dashboard. Maintainer+ / platform admins still see all.
  const rows = await getOrgPortfolios(c.env, uniqueOrgIds, { userId: user.id, isAdmin })
  const byOrg = new Map<number, typeof rows>()
  for (const row of rows) {
    const list = byOrg.get(row.orgId)
    if (list) list.push(row)
    else byOrg.set(row.orgId, [row])
  }

  return c.json({
    portfolios: uniqueOrgIds.map((orgId) => ({
      orgId,
      projects: (byOrg.get(orgId) ?? []).map(({ orgId: _orgId, ...project }) => project),
    })),
  })
})

/** GET /api/v2/orgs/:orgId/portfolio — per-project rollup for org (derive-on-read). */
orgs.get("/:orgId/portfolio", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  // AQU-745: filter to the caller's visible projects (creator/direct/group, or
  // all when Maintainer+/admin) so the org dashboard never leaks project names
  // a regular member has no access to.
  const isAdmin = isPlatformAdminEmail(c.env, user.email)
  const projects = await getOrgPortfolio(c.env, orgId, { userId: user.id, isAdmin })
  return c.json({ projects })
})

/**
 * GET /api/v2/orgs/:orgId/deleted-files — soft-deleted files across projects
 * the caller can see. Powers the Archived page's Recently deleted tab.
 */
orgs.get("/:orgId/deleted-files", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const isAdmin = isPlatformAdminEmail(c.env, user.email)
  const files = await getOrgDeletedFiles(c.env, orgId, { userId: user.id, isAdmin })
  return c.json({ files })
})

/**
 * GET /api/v2/orgs/:orgId/members/:userId/access — AD-12 effective-access
 * breakdown: every grant path (direct/group/org/creator) per project + the
 * resolved max. Maintainer+ (managers) only.
 */
orgs.get("/:orgId/members/:userId/access", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const targetUserId = parseInt(c.req.param("userId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid id" }, 400)
  }
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null || role < ROLE.MAINTAINER) {
    return c.json({ error: "org role >= maintainer required" }, 403)
  }
  const access = await getMemberEffectiveAccess(c.env, orgId, targetUserId)
  return c.json(access)
})

/**
 * GET /api/v2/orgs/:orgId/assignments/workload — every open assignment across
 * the org's active projects, with project + progress attribution (AQU-494:
 * one row per assignment, not aggregated by assignee, so the manager can see
 * which project each assignment belongs to and remove any one of them).
 * Maintainer+ (managers).
 */
orgs.get("/:orgId/assignments/workload", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null || role < ROLE.MAINTAINER) {
    return c.json({ error: "org role >= maintainer required" }, 403)
  }
  const assignments = await getOrgAssignmentWorkload(c.env, orgId)
  return c.json({ assignments })
})

/**
 * GET /api/v2/orgs/:orgId/assignments/mine — the caller's open assignments
 * across ALL the org's active projects, in ONE request (replaces the client's
 * per-project /:projectId/assignments/mine fan-out). Any org member.
 */
orgs.get("/:orgId/assignments/mine", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const assignments = await getMyAssignmentsAcrossOrg(c.env, orgId, user.id)
  return c.json({ assignments })
})

/**
 * GET /api/v2/orgs/:orgId/members-matrix — effective members for every project
 * the caller can access in the org, in ONE request (AQU-218). Replaces the
 * client's per-project /:projectId/members fan-out that flooded the connection
 * pool and 500'd the page. Any org member.
 */
orgs.get("/:orgId/members-matrix", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null) return c.json({ error: "not an org member" }, 403)

  const projects = await listEffectiveMembersForOrg(c.env, orgId, user.id)
  await bumpOrgActivity(c.env, user.id, orgId)
  return c.json({
    projects: projects.map((p) => ({
      projectId: p.projectId,
      members: p.members.map((m) => ({
        userId: m.userId,
        username: m.username,
        role: { level: m.roleLevel, name: ROLE_NAMES[m.roleLevel] ?? `level_${m.roleLevel}`, source: m.source },
        secondarySources: m.secondarySources,
      })),
    })),
  })
})

/**
 * GET /api/v2/orgs/:orgId/members — caller must be an org member.
 *
 * AQU-485: additionally gated by the org's configured rosterViewMinRole
 * (default MAINTAINER=600). A member whose effective role is below the
 * floor gets a distinct 403 (`error: "roster hidden by org policy"`,
 * `rosterHidden: true`) rather than the member list — the caller must not
 * be able to infer the roster or its size from this response.
 */
orgs.get("/:orgId/members", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null) return c.json({ error: "not an org member" }, 403)

  const rosterMinRole = await getRosterViewMinRole(c.env, orgId)
  if (!canViewRoster(role, rosterMinRole)) {
    return c.json({ error: "roster hidden by org policy", rosterHidden: true }, 403)
  }

  const members = await listOrgMembersWithUsers(c.env, orgId)
  await bumpOrgActivity(c.env, user.id, orgId)
  return c.json({
    members: members.map((m) => ({
      userId: m.userId,
      username: m.username,
      role: { level: m.roleLevel, name: ROLE_NAMES[m.roleLevel] ?? "unknown" },
      lastActiveAt: m.lastActiveAt,
    })),
  })
})

/** GET /api/v2/orgs/:orgId/groups — read-only team list (org members). */
orgs.get("/:orgId/groups", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const groups = await listOrgGroups(c.env, orgId, user.id)
  // AQU-789: the Teams list must agree with the team-detail visibility gate
  // (AQU-748). A non-maintainer can only open a team they belong to, so listing
  // teams they aren't in produces the "phantom membership" bug — a team shows in
  // the list but its detail 404s ("it says I have a team but I'm not part of
  // it"). Filter the list to the viewer's own teams for non-maintainers;
  // maintainers+ see every team, matching their detail access.
  const visible = role >= ROLE.MAINTAINER ? groups : groups.filter((g) => g.viewerIsMember)
  return c.json({ groups: visible })
})

/** GET /api/v2/orgs/:orgId/groups/:groupId — read-only team detail. */
orgs.get("/:orgId/groups/:groupId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const detail = await getOrgGroupDetail(c.env, orgId, groupId)
  if (!detail) return c.json({ error: "group not found" }, 404)
  // AQU-748: a team's member list is only visible to maintainers+ (600+) or to
  // members of that team. A regular contributor must not see the membership of
  // teams they don't belong to. (Distinct 404 vs 403 would let a non-member probe
  // which team ids exist, so mirror the not-found response.)
  if (role < ROLE.MAINTAINER && !detail.members.some((m) => m.userId === user.id)) {
    return c.json({ error: "group not found" }, 404)
  }
  return c.json(detail)
})

const groupBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
})

orgs.post("/:orgId/groups", zValidator("json", groupBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  const { name, description } = c.req.valid("json")
  const group = await createGroup(c.env, orgId, name, description ?? null, user.id)
  if (!group) return c.json({ error: "a team with that name already exists" }, 409)
  return c.json(group)
})

const groupPatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
})

orgs.patch("/:orgId/groups/:groupId", zValidator("json", groupPatchBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { name, description } = c.req.valid("json")
  const updated = await updateGroup(c.env, orgId, groupId, name, description)
  if (!updated) return c.json({ error: "a team with that name already exists" }, 409)
  return c.json(updated)
})

orgs.delete("/:orgId/groups/:groupId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  await deleteGroup(c.env, orgId, groupId)
  return c.json({ removed: true })
})

// AQU-736: team membership has no role, so the batch shape is a plain username
// array (`{ usernames: [...] }`). The legacy single-user body (`{ username }`)
// keeps working exactly as before.
const memberSingle = z.object({ username: z.string().min(1) })
const memberBatch = z.object({ usernames: z.array(z.string().min(1)).min(1).max(100) })
const memberBody = z.union([memberBatch, memberSingle])

const GROUP_GRANT_ERROR_STATUS: Record<string, 404 | 409> = {
  user_not_found: 404,
  not_org_member: 409,
}

type GroupGrantOutcome =
  | { ok: true; userId: number; username: string }
  | { ok: false; username: string; code: string; message: string }

/**
 * Evaluate + apply a single team-member grant. Per-target so a batch never rolls
 * the valid grants back on one bad entry; single-user callers see the same
 * outcomes as before.
 */
async function grantGroupMemberOne(
  env: Env,
  orgId: number,
  groupId: number,
  addedBy: number,
  username: string,
): Promise<GroupGrantOutcome> {
  const target = await lookupUserByUsername(env, username)
  if (!target) {
    return { ok: false, username, code: "user_not_found", message: "user not found" }
  }
  const result = await addGroupMember(env, orgId, groupId, target.id, addedBy)
  if (result === "not-org-member") {
    return { ok: false, username, code: "not_org_member", message: "user is not a member of this org" }
  }
  return { ok: true, userId: target.id, username: target.username }
}

orgs.post("/:orgId/groups/:groupId/members", zValidator("json", memberBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)

  const body = c.req.valid("json")

  if ("usernames" in body) {
    const seen = new Set<string>()
    const names = body.usernames.filter((u) => {
      const key = u.trim().toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const results: Array<
      { username: string; ok: true } | { username: string; ok: false; error: { code: string; message: string } }
    > = []
    for (const username of names) {
      const outcome = await grantGroupMemberOne(c.env, orgId, groupId, user.id, username)
      results.push(
        outcome.ok
          ? { username, ok: true }
          : { username, ok: false, error: { code: outcome.code, message: outcome.message } },
      )
    }
    return c.json({ results })
  }

  const outcome = await grantGroupMemberOne(c.env, orgId, groupId, user.id, body.username)
  if (!outcome.ok) {
    return c.json({ error: outcome.message }, GROUP_GRANT_ERROR_STATUS[outcome.code] ?? 400)
  }
  return c.json({ userId: outcome.userId, username: outcome.username })
})

orgs.delete("/:orgId/groups/:groupId/members/:userId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  const targetUserId = parseInt(c.req.param("userId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId) || !Number.isFinite(targetUserId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  await removeGroupMember(c.env, groupId, targetUserId)
  return c.json({ removed: true })
})

// Strict role validation — only the seven canonical levels are accepted.
const orgMemberSingle = z.object({
  username: z.string().min(1),
  role: z
    .number()
    .int()
    .refine(isCanonicalRoleLevel, {
      message: `role must be one of ${ALL_ROLE_LEVELS.join(", ")}`,
    }),
})

// AQU-736: accept EITHER the legacy single-user body or a batch
// (`{ members: [{ username, role }, …] }`). The single-user shape is preserved
// exactly for existing callers; the batch shape powers multi-select add.
const orgMemberBatch = z.object({
  members: z.array(orgMemberSingle).min(1).max(100),
})
const orgMemberBody = z.union([orgMemberBatch, orgMemberSingle])

const ORG_GRANT_ERROR_STATUS: Record<string, 400 | 404> = {
  user_not_found: 404,
  self_grant: 400,
}

type OrgGrantOutcome =
  | { ok: true; userId: number; username: string; role: number }
  | { ok: false; username: string; code: string; message: string }

/**
 * Evaluate + apply a single org-member grant. Checks are per target so a batch
 * never rolls the valid grants back on one bad entry. Owner-only is enforced by
 * the caller as a whole-request gate (matching the pre-batch behavior); there is
 * no role-cap or target-outranks check on this endpoint, so single-user callers
 * see exactly the same outcomes as before.
 */
async function grantOrgMemberOne(
  env: Env,
  orgId: number,
  callerUserId: number,
  entry: { username: string; role: number },
): Promise<OrgGrantOutcome> {
  const { username, role } = entry
  const target = await lookupUserByUsername(env, username)
  if (!target) {
    return { ok: false, username, code: "user_not_found", message: "user not found" }
  }
  if (target.id === callerUserId) {
    return { ok: false, username, code: "self_grant", message: "cannot grant role to self" }
  }

  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id, user_id) DO UPDATE SET
       role_level = excluded.role_level,
       granted_by = excluded.granted_by,
       granted_at = CURRENT_TIMESTAMP`,
  )
    .bind(orgId, target.id, role, callerUserId)
    .run()

  return { ok: true, userId: target.id, username: target.username, role }
}

/** POST /api/v2/orgs/:orgId/members — owner-only add/update (single or batch). */
orgs.post(
  "/:orgId/members",
  zValidator("json", orgMemberBody),
  async (c) => {
    const user = c.get("user")
    const orgId = parseInt(c.req.param("orgId"), 10)
    if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

    const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
    if (callerRole == null || callerRole < 700) {
      return c.json({ error: "only org owners can add members" }, 403)
    }

    const body = c.req.valid("json")

    if ("members" in body) {
      const seen = new Set<string>()
      const entries = body.members.filter((m) => {
        const key = m.username.trim().toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const results: Array<
        { username: string; ok: true } | { username: string; ok: false; error: { code: string; message: string } }
      > = []
      for (const entry of entries) {
        const outcome = await grantOrgMemberOne(c.env, orgId, user.id, entry)
        results.push(
          outcome.ok
            ? { username: entry.username, ok: true }
            : { username: entry.username, ok: false, error: { code: outcome.code, message: outcome.message } },
        )
      }
      return c.json({ results })
    }

    const outcome = await grantOrgMemberOne(c.env, orgId, user.id, body)
    if (!outcome.ok) {
      return c.json({ error: outcome.message }, ORG_GRANT_ERROR_STATUS[outcome.code] ?? 400)
    }
    return c.json({
      userId: outcome.userId,
      username: outcome.username,
      role: { level: outcome.role, name: ROLE_NAMES[outcome.role] ?? "unknown" },
    })
  },
)

// ── Email-based organization invitations ──────────────────────────────────
//   POST   /:orgId/invites          owner mints a tokenized (optionally
//                                    email-bound) invite, best-effort email
//   GET    /:orgId/invites          owner lists active (unused + unexpired)
//   DELETE /:orgId/invites/:token   owner revokes an unused invite
//   POST   /accept-invite           invitee redeems → org_members grant
//
// Mirrors the project-invite flow (routes/projects.ts) but org-scoped. Granted
// role is capped below OWNER so an org can't be handed over via a leaked link.

interface OrgInviteRow {
  token: string
  org_id: number
  role_level: number
  created_by: number
  created_at: string
  expires_at: string | null
  used_by: number | null
  used_at: string | null
  email: string | null
}

const createOrgInviteBody = z.object({
  // Org-grantable levels only; OWNER (700) is never grantable via link.
  role: z.number().int().min(100).max(600).optional(),
  email: z.string().email().optional(),
  // null = no expiry; undefined = server default (30 days).
  expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
})

const acceptOrgInviteBody = z.object({ token: z.string().min(8) })

orgs.post("/:orgId/invites", zValidator("json", createOrgInviteBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.OWNER) {
    return c.json({ error: "only org owners can invite members" }, 403)
  }

  const { role, email, expires_in_days } = c.req.valid("json")
  let grantedRole = role ?? ROLE.CONTRIBUTOR
  if (grantedRole >= ROLE.OWNER) grantedRole = ROLE.MAINTAINER
  if (grantedRole < ROLE.VIEWER) grantedRole = ROLE.VIEWER

  const token = crypto.randomUUID().replace(/-/g, "")
  const expiresAt =
    expires_in_days === null
      ? null
      : new Date(
          Date.now() + (expires_in_days !== undefined ? expires_in_days : 30) * 24 * 60 * 60 * 1000,
        ).toISOString()

  try {
    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO org_invites
         (token, org_id, role_level, created_by, expires_at, email)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(token, orgId, grantedRole, user.id, expiresAt, email ?? null)
      .run()
  } catch (err) {
    console.error("[org-invites] create failed:", err)
    return c.json({ error: "Failed to create invite" }, 500)
  }

  if (email) {
    const baseUrl = c.env.BASE_URL || "https://aquilla.app"
    const joinUrl = `${baseUrl}/join-org/${token}`
    const org = await c.env.AQUILLA_PG.prepare(
      "SELECT name FROM organizations WHERE id = ?",
    )
      .bind(orgId)
      .first<{ name: string | null }>()
    const emailPromise = sendOrgInviteEmail(
      c.env,
      email,
      joinUrl,
      org?.name ?? "an organization",
      { invitedBy: user.username },
    ).catch((err) => console.warn("[org-invites] invite email failed:", err))
    try {
      c.executionCtx.waitUntil(emailPromise)
    } catch {
      void emailPromise
    }
  }

  return c.json({
    token,
    orgId,
    role: { level: grantedRole, name: ROLE_NAMES[grantedRole] ?? "unknown" },
    expiresAt,
    ...(email ? { email } : {}),
  })
})

orgs.get("/:orgId/invites", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.OWNER) {
    return c.json({ error: "only org owners can view invites" }, 403)
  }

  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT token, role_level, created_at, expires_at, email
     FROM org_invites
     WHERE org_id = ?
       AND used_at IS NULL
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
     ORDER BY created_at DESC`,
  )
    .bind(orgId)
    .all<{
      token: string
      role_level: number
      created_at: string
      expires_at: string | null
      email: string | null
    }>()

  return c.json({
    invites: (rows.results ?? []).map((r) => ({
      token: r.token,
      role: { level: r.role_level, name: ROLE_NAMES[r.role_level] ?? "unknown" },
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      email: r.email ?? null,
    })),
  })
})

orgs.delete("/:orgId/invites/:token", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const token = c.req.param("token")

  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.OWNER) {
    return c.json({ error: "only org owners can revoke invites" }, 403)
  }

  await c.env.AQUILLA_PG.prepare(
    `DELETE FROM org_invites WHERE token = ? AND org_id = ? AND used_at IS NULL`,
  )
    .bind(token, orgId)
    .run()
  return c.json({ ok: true })
})

orgs.post("/accept-invite", zValidator("json", acceptOrgInviteBody), async (c) => {
  const user = c.get("user")
  const { token } = c.req.valid("json")

  const invite = await c.env.AQUILLA_PG.prepare(
    `SELECT token, org_id, role_level, created_by, created_at,
            expires_at, used_by, used_at, email
     FROM org_invites WHERE token = ?`,
  )
    .bind(token)
    .first<OrgInviteRow>()
  if (!invite) return c.json({ error: "Invite not found" }, 404)
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return c.json({ error: "Invite expired" }, 410)
  }
  if (invite.used_at && invite.used_by !== user.id) {
    return c.json({ error: "Invite already used" }, 410)
  }
  // Email-bound invites: the redeemer's account email must match (case-insensitive).
  if (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return c.json(
      { error: "This invite was sent to a different email address." },
      403,
    )
  }

  const org = await c.env.AQUILLA_PG.prepare(
    "SELECT id, name FROM organizations WHERE id = ?",
  )
    .bind(invite.org_id)
    .first<{ id: number; name: string | null }>()
  if (!org) return c.json({ error: "Organization not found" }, 404)

  const existing = await c.env.AQUILLA_PG.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(invite.org_id, user.id)
    .first<{ role_level: number }>()
  const finalRole = existing
    ? Math.max(existing.role_level, invite.role_level)
    : invite.role_level

  try {
    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, user_id) DO UPDATE SET
         role_level = excluded.role_level,
         granted_by = excluded.granted_by,
         granted_at = CURRENT_TIMESTAMP`,
    )
      .bind(invite.org_id, user.id, finalRole, invite.created_by)
      .run()
    // Atomic stamp: only the first concurrent redeemer wins.
    await c.env.AQUILLA_PG.prepare(
      `UPDATE org_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP
       WHERE token = ? AND used_at IS NULL`,
    )
      .bind(user.id, token)
      .run()
  } catch (err) {
    console.error("[org-invites] accept failed:", err)
    return c.json({ error: "Failed to accept invite" }, 500)
  }

  return c.json({
    orgId: invite.org_id,
    orgName: org.name,
    role: { level: finalRole, name: ROLE_NAMES[finalRole] ?? "unknown" },
  })
})

/** DELETE /api/v2/orgs/:orgId/members/:userId — owner-only. */
orgs.delete("/:orgId/members/:userId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const targetUserId = parseInt(c.req.param("userId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid id" }, 400)
  }

  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < 700) {
    return c.json({ error: "only org owners can remove members" }, 403)
  }
  if (targetUserId === user.id) {
    return c.json({ error: "owner cannot remove self" }, 400)
  }

  await c.env.AQUILLA_PG.batch([
    c.env.AQUILLA_PG.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, targetUserId),
    c.env.AQUILLA_PG.prepare(
      `DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT id FROM groups WHERE org_id = ?)`,
    ).bind(targetUserId, orgId),
  ])

  return c.json({ removed: true })
})

/**
 * GET /api/v2/orgs/:orgId/members/:userId/projects
 *
 * For the "remove from org" confirmation: list the projects in this org
 * where the given user has a direct project_members row. Owner-only.
 */
orgs.get("/:orgId/members/:userId/projects", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const targetUserId = parseInt(c.req.param("userId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid id" }, 400)
  }
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < 700) {
    return c.json({ error: "only org owners can list memberships" }, 403)
  }

  const rows = await listUserDirectMembershipsInOrg(c.env, orgId, targetUserId)
  return c.json({
    projects: rows.map((r) => ({
      id: r.projectId,
      name: r.projectName,
      role: { level: r.roleLevel, name: ROLE_NAMES[r.roleLevel] ?? "unknown" },
    })),
  })
})

/**
 * GET /api/v2/orgs/:orgId/project-invites
 *
 * List unredeemed, unexpired project_invites for projects in this org.
 * Owner-only — the listing exposes invite tokens, which are bearer
 * credentials. Used by the Roster's "Pending invitations" section.
 *
 * Deliberately a distinct path from GET /:orgId/invites (org_invites,
 * above) — those two routes used to collide on the same path/method, which
 * silently shadowed this handler and left the Roster rendering org_invites
 * rows (no createdBy) as if they were project_invites rows.
 */
orgs.get("/:orgId/project-invites", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < 700) {
    return c.json({ error: "only org owners can list pending invites" }, 403)
  }

  const invites = await listPendingInvitesInOrg(c.env, orgId)
  return c.json({
    invites: invites.map((inv) => ({
      token: inv.token,
      projectId: inv.projectId,
      projectName: inv.projectName,
      role: {
        level: inv.roleLevel,
        name: ROLE_NAMES[inv.roleLevel] ?? "unknown",
      },
      createdBy: { userId: inv.createdByUserId, username: inv.createdByUsername },
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      email: inv.email,
    })),
  })
})

const attachBody = z.object({ projectId: z.string().min(1), roleLevel: z.number().int() })
const roleBody = z.object({ roleLevel: z.number().int() })

orgs.post("/:orgId/groups/:groupId/projects", zValidator("json", attachBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { projectId, roleLevel } = c.req.valid("json")
  if (!isCanonicalRoleLevel(roleLevel) || roleLevel > callerRole) return c.json({ error: "invalid or too-high role level" }, 403)
  const result = await attachGroupProject(c.env, orgId, groupId, projectId, roleLevel, user.id)
  if (result === "no-project") return c.json({ error: "project not found" }, 404)
  if (result === "cross-org") return c.json({ error: "project is not in this org" }, 409)
  return c.json({ projectId, roleLevel })
})

orgs.patch("/:orgId/groups/:groupId/projects/:projectId", zValidator("json", roleBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  const projectId = c.req.param("projectId")
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { roleLevel } = c.req.valid("json")
  if (!isCanonicalRoleLevel(roleLevel) || roleLevel > callerRole) return c.json({ error: "invalid or too-high role level" }, 403)
  const ok = await updateGroupProjectRole(c.env, groupId, projectId, roleLevel)
  if (!ok) return c.json({ error: "attachment not found" }, 404)
  return c.json({ projectId, roleLevel })
})

orgs.delete("/:orgId/groups/:groupId/projects/:projectId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  const projectId = c.req.param("projectId")
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  await detachGroupProject(c.env, groupId, projectId)
  return c.json({ removed: true })
})

export default orgs
