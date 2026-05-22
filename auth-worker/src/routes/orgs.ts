// Organization routes. Ported from frontier-server's
// `cloudflare/src/routes/orgs.ts`. Personal-org lazy-create, members CRUD,
// member-project listing, and pending-invite listing.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  bumpOrgActivity,
  getOrCreateUserOrg,
  getOrgMemberRole,
  listOrgMembersWithUsers,
  listPendingInvitesInOrg,
  listUserDirectMembershipsInOrg,
} from "../services/org-permissions"
import {
  ALL_ROLE_LEVELS,
  isCanonicalRoleLevel,
  ROLE_NAMES,
} from "../services/project-permissions"
import { lookupUserByUsername } from "../services/user-lookup"

const orgs = new Hono<AuthHonoEnv>()

orgs.use("*", authMiddleware)

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

/** GET /api/v2/orgs/:orgId/members — caller must be an org member. */
orgs.get("/:orgId/members", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null) return c.json({ error: "not an org member" }, 403)

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

    const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
    if (callerRole == null || callerRole < 700) {
      return c.json({ error: "only org owners can add members" }, 403)
    }

    const { username, role } = c.req.valid("json")
    const target = await lookupUserByUsername(c.env, username)
    if (!target) return c.json({ error: "user not found" }, 404)
    if (target.id === user.id) {
      return c.json({ error: "cannot grant role to self" }, 400)
    }

    await c.env.AQUILLA_DB.prepare(
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

/** DELETE /api/v2/orgs/:orgId/members/:userId — owner-only. */
orgs.delete("/:orgId/members/:userId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const targetUserId = parseInt(c.req.param("userId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid id" }, 400)
  }

  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < 700) {
    return c.json({ error: "only org owners can remove members" }, 403)
  }
  if (targetUserId === user.id) {
    return c.json({ error: "owner cannot remove self" }, 400)
  }

  await c.env.AQUILLA_DB.prepare(
    "DELETE FROM org_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(orgId, targetUserId)
    .run()

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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
 * GET /api/v2/orgs/:orgId/invites
 *
 * List unredeemed, unexpired project_invites for projects in this org.
 * Owner-only — the listing exposes invite tokens, which are bearer
 * credentials. Used by the Roster's "Pending invitations" section.
 */
orgs.get("/:orgId/invites", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
    })),
  })
})

export default orgs
