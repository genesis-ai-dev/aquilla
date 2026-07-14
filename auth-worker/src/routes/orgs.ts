// Organization routes. Ported from frontier-server's
// `cloudflare/src/routes/orgs.ts`. Personal-org lazy-create, members CRUD,
// member-project listing, and pending-invite listing.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { isPlatformAdminEmail } from "../middleware/platform-admin"
import { ROLE } from "../types"
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

  if (!isPlatformAdminEmail(c.env, user.email)) {
    const placeholders = uniqueOrgIds.map(() => "?").join(", ")
    const allowed = await c.env.AQUILLA_PG.prepare(
      `SELECT org_id FROM org_members WHERE user_id = ? AND org_id IN (${placeholders})`,
    ).bind(user.id, ...uniqueOrgIds).all<{ org_id: number }>()
    const allowedOrgIds = new Set((allowed.results ?? []).map((row) => row.org_id))
    if (uniqueOrgIds.some((orgId) => !allowedOrgIds.has(orgId))) {
      return c.json({ error: "not an org member" }, 403)
    }
  }

  const rows = await getOrgPortfolios(c.env, uniqueOrgIds)
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
  const projects = await getOrgPortfolio(c.env, orgId)
  return c.json({ projects })
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
  return c.json({ groups })
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

const memberBody = z.object({ username: z.string().min(1) })

orgs.post("/:orgId/groups/:groupId/members", zValidator("json", memberBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getEffectiveOrgRole(c.env, orgId, user)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  const { username } = c.req.valid("json")
  const target = await lookupUserByUsername(c.env, username)
  if (!target) return c.json({ error: "user not found" }, 404)
  const result = await addGroupMember(c.env, orgId, groupId, target.id, user.id)
  if (result === "not-org-member") return c.json({ error: "user is not a member of this org" }, 409)
  return c.json({ userId: target.id, username: target.username })
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
const orgMemberBody = z.object({
  username: z.string().min(1),
  role: z
    .number()
    .int()
    .refine(isCanonicalRoleLevel, {
      message: `role must be one of ${ALL_ROLE_LEVELS.join(", ")}`,
    }),
})

/** POST /api/v2/orgs/:orgId/members — owner-only add/update. */
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

    const { username, role } = c.req.valid("json")
    const target = await lookupUserByUsername(c.env, username)
    if (!target) return c.json({ error: "user not found" }, 404)
    if (target.id === user.id) {
      return c.json({ error: "cannot grant role to self" }, 400)
    }

    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, user_id) DO UPDATE SET
         role_level = excluded.role_level,
         granted_by = excluded.granted_by,
         granted_at = CURRENT_TIMESTAMP`,
    )
      .bind(orgId, target.id, role, user.id)
      .run()

    return c.json({
      userId: target.id,
      username: target.username,
      role: { level: role, name: ROLE_NAMES[role] ?? "unknown" },
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
