// Organization routes. Ported from frontier-server's
// `cloudflare/src/routes/orgs.ts`. Personal-org lazy-create, members CRUD,
// member-project listing, and pending-invite listing.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import {
  addGroupMember,
  attachGroupProject,
  bumpOrgActivity,
  createGroup,
  createOrgForUser,
  deleteGroup,
  detachGroupProject,
  getMemberEffectiveAccess,
  getOrCreateUserOrg,
  getOrgGroupDetail,
  getOrgMemberRole,
  getOrgPortfolio,
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

const orgs = new Hono<AuthHonoEnv>()

orgs.use("*", authMiddleware)

/** GET /api/v2/orgs — every org the caller belongs to (owned + member). */
orgs.get("/", async (c) => {
  const user = c.get("user")
  const list = await listUserOrgs(c.env, user)
  return c.json({
    orgs: list.map((o) => ({
      id: o.id,
      name: o.name,
      role: { level: o.role, name: ROLE_NAMES[o.role] ?? "unknown" },
    })),
  })
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
  const role = await getOrgMemberRole(c.env, orgId, user.id)
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

/** GET /api/v2/orgs/:orgId/portfolio — per-project rollup for org (derive-on-read). */
orgs.get("/:orgId/portfolio", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
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
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null || role < ROLE.MAINTAINER) {
    return c.json({ error: "org role >= maintainer required" }, 403)
  }
  const access = await getMemberEffectiveAccess(c.env, orgId, targetUserId)
  return c.json(access)
})

/**
 * GET /api/v2/orgs/:orgId/assignments/workload — per-assignee open workload +
 * derived progress across the org's active projects. Maintainer+ (managers).
 */
orgs.get("/:orgId/assignments/workload", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null || role < ROLE.MAINTAINER) {
    return c.json({ error: "org role >= maintainer required" }, 403)
  }
  const workload = await getOrgAssignmentWorkload(c.env, orgId)
  return c.json({ workload })
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
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const assignments = await getMyAssignmentsAcrossOrg(c.env, orgId, user.id)
  return c.json({ assignments })
})

/**
 * GET /api/v2/orgs/:orgId/members-matrix — effective members for every project
 * the caller can access in the org, in ONE request (FRO-218). Replaces the
 * client's per-project /:projectId/members fan-out that flooded the connection
 * pool and 500'd the page. Any org member.
 */
orgs.get("/:orgId/members-matrix", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const role = await getOrgMemberRole(c.env, orgId, user.id)
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

/** GET /api/v2/orgs/:orgId/groups — read-only team list (org members). */
orgs.get("/:orgId/groups", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
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
  const role = await getOrgMemberRole(c.env, orgId, user.id)
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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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

  await c.env.AQUILLA_DB.batch([
    c.env.AQUILLA_DB.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, targetUserId),
    c.env.AQUILLA_DB.prepare(
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

const attachBody = z.object({ projectId: z.string().min(1), roleLevel: z.number().int() })
const roleBody = z.object({ roleLevel: z.number().int() })

orgs.post("/:orgId/groups/:groupId/projects", zValidator("json", attachBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
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
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id)
  if (callerRole == null || callerRole < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  if (!(await groupExistsInOrg(c.env, orgId, groupId))) return c.json({ error: "group not found" }, 404)
  await detachGroupProject(c.env, groupId, projectId)
  return c.json({ removed: true })
})

export default orgs
