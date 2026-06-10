// Project invites: link-share tokens for codex-web projects.
//
// Built fresh for the auth-worker — these routes don't exist in the stale
// frontier-server fork. Three endpoints:
//
//   POST /api/v2/projects/:projectId/invites — sharer mints an invite
//   GET  /api/v2/projects/invite-preview/:token — JoinPage prefill (public)
//   POST /api/v2/projects/accept-invite — joiner redeems
//
// Wire shapes match src/lib/sync/invites.ts exactly. role caps at
// CONTRIBUTOR (400) — managerial roles are never granted via a tokenized URL.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { isPlatformAdminUsername } from "../middleware/platform-admin"
import {
  INVITE_MIN_ROLE,
  LINK_ROLE_CAP,
  ROLE,
  type AuthUser,
  type Env,
  type ProjectInviteRow,
  type ProjectRow,
} from "../types"

const projectsInvites = new Hono<AuthHonoEnv>()

// Default invite lifetime — 30 days. Mirrors the open-link UX of the old
// share-token flow and gives recipients time to redeem on a fresh laptop.
const DEFAULT_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const createInviteSchema = z.object({
  role: z.number().int().min(100).max(700).optional(),
  email: z.string().email().optional(),
})

const acceptInviteSchema = z.object({
  token: z.string().min(8),
})

function roleNameFor(level: number): string {
  switch (level) {
    case 100: return "viewer"
    case 200: return "commenter"
    case 300: return "reviewer"
    case 400: return "contributor"
    case 500: return "project_lead"
    case 600: return "maintainer"
    case 700: return "owner"
    default: return `level_${level}`
  }
}

async function resolveProjectRole(
  env: Env,
  projectId: string,
  user: AuthUser,
): Promise<{ project: ProjectRow; level: number } | null> {
  const project = await env.AQUILLA_PG.prepare(
    `SELECT id, name, gitlab_project_id, org_id, created_by, archived_at
       FROM projects WHERE id = ?`,
  )
    .bind(projectId)
    .first<ProjectRow>()
  if (!project) return null

  const member = await env.AQUILLA_PG.prepare(
    `SELECT role_level FROM project_members
       WHERE project_id = ? AND user_id = ?`,
  )
    .bind(projectId, user.id)
    .first<{ role_level: number }>()
  if (member) return { project, level: member.role_level }
  if (project.created_by === user.id) {
    return { project, level: ROLE.OWNER }
  }
  // Platform operators can mint invites on any project (support path).
  if (isPlatformAdminUsername(env, user.username)) {
    return { project, level: ROLE.OWNER }
  }
  return null
}

// POST /api/v2/projects/:projectId/invites — sharer side.
projectsInvites.post(
  "/:projectId/invites",
  authMiddleware,
  zValidator("json", createInviteSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId")
    const { role, email } = c.req.valid("json")

    const resolved = await resolveProjectRole(c.env, projectId, user)
    if (!resolved) {
      return c.json({ error: "Project not found" }, 404)
    }
    if (resolved.project.archived_at) {
      return c.json({ error: "Project is archived" }, 403)
    }
    if (resolved.level < INVITE_MIN_ROLE) {
      return c.json(
        { error: "You don't have permission to share this project" },
        403,
      )
    }

    // Cap the granted role at contributor — managerial roles aren't grantable
    // via tokenized URLs. Default to contributor when role is omitted.
    let grantedRole = role ?? ROLE.CONTRIBUTOR
    if (grantedRole > LINK_ROLE_CAP) grantedRole = LINK_ROLE_CAP
    if (grantedRole < ROLE.VIEWER) grantedRole = ROLE.VIEWER

    const token = crypto.randomUUID().replace(/-/g, "")
    const expiresAt = new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString()

    try {
      // `project_invites.email` doesn't exist in prod schema today; we encode
      // the recipient as a JSON note in `used_by`? No — that mutates semantics.
      // Instead: store the email-bound metadata in a future column or simply
      // ignore it for now (the token is still the sole credential). We keep
      // the email in the response so the client can echo it in the UI.
      await c.env.AQUILLA_PG.prepare(
        `INSERT INTO project_invites
           (token, project_id, role_level, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(token, projectId, grantedRole, user.id, expiresAt)
        .run()
    } catch (err) {
      console.error("[invites] create failed:", err)
      return c.json({ error: "Failed to create invite" }, 500)
    }

    return c.json({
      token,
      projectId,
      role: grantedRole,
      expiresAt,
      ...(email ? { email } : {}),
    })
  },
)

// GET /api/v2/projects/invite-preview/:token — public, no JWT required.
// Returns enough metadata for JoinPage to render context before signin.
projectsInvites.get("/invite-preview/:token", async (c) => {
  const token = c.req.param("token")
  if (!token || token.length < 8) {
    return c.json({ error: "Invalid token" }, 404)
  }

  const invite = await c.env.AQUILLA_PG.prepare(
    `SELECT token, project_id, role_level, created_by, created_at,
            expires_at, used_by, used_at
     FROM project_invites WHERE token = ?`,
  )
    .bind(token)
    .first<ProjectInviteRow>()

  if (!invite) {
    return c.json({ error: "Invite not found" }, 404)
  }
  if (invite.expires_at) {
    const expiresAt = new Date(invite.expires_at)
    if (expiresAt < new Date()) {
      return c.json({ error: "Invite expired" }, 410)
    }
  }
  if (invite.used_at) {
    return c.json({ error: "Invite already used" }, 410)
  }

  const project = await c.env.AQUILLA_PG.prepare(
    `SELECT id, name, gitlab_project_id, org_id, created_by, archived_at
     FROM projects WHERE id = ?`,
  )
    .bind(invite.project_id)
    .first<ProjectRow>()
  if (!project) {
    return c.json({ error: "Project not found" }, 404)
  }
  if (project.archived_at) {
    return c.json({ error: "Project is archived" }, 410)
  }

  return c.json({
    projectId: invite.project_id,
    projectName: project.name,
    role: {
      level: invite.role_level,
      name: roleNameFor(invite.role_level),
    },
    expiresAt: invite.expires_at,
    // Email-bound invites aren't persisted yet (schema doesn't have the
    // column). Always null until the column is added.
    email: null,
  })
})

// POST /api/v2/projects/accept-invite — joiner side.
projectsInvites.post(
  "/accept-invite",
  authMiddleware,
  zValidator("json", acceptInviteSchema),
  async (c) => {
    const user = c.get("user")
    const { token } = c.req.valid("json")

    const invite = await c.env.AQUILLA_PG.prepare(
      `SELECT token, project_id, role_level, created_by, created_at,
              expires_at, used_by, used_at
       FROM project_invites WHERE token = ?`,
    )
      .bind(token)
      .first<ProjectInviteRow>()
    if (!invite) {
      return c.json({ error: "Invite not found" }, 404)
    }
    if (invite.expires_at) {
      const expiresAt = new Date(invite.expires_at)
      if (expiresAt < new Date()) {
        return c.json({ error: "Invite expired" }, 410)
      }
    }
    if (invite.used_at && invite.used_by !== user.id) {
      // Single-use guard. Lets the same user redeem twice (no-op) but blocks
      // a stranger reusing a leaked token.
      return c.json({ error: "Invite already used" }, 410)
    }

    // Idempotent membership upsert: if the caller already has a row, keep
    // the higher of the two role levels so accepting a lower-rung invite
    // doesn't demote a maintainer.
    const existing = await c.env.AQUILLA_PG.prepare(
      `SELECT role_level FROM project_members
       WHERE project_id = ? AND user_id = ?`,
    )
      .bind(invite.project_id, user.id)
      .first<{ role_level: number }>()

    const finalRole = existing
      ? Math.max(existing.role_level, invite.role_level)
      : invite.role_level

    try {
      if (existing) {
        await c.env.AQUILLA_PG.prepare(
          `UPDATE project_members
           SET role_level = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
           WHERE project_id = ? AND user_id = ?`,
        )
          .bind(finalRole, invite.created_by, invite.project_id, user.id)
          .run()
      } else {
        await c.env.AQUILLA_PG.prepare(
          `INSERT INTO project_members
             (project_id, user_id, role_level, granted_by)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(invite.project_id, user.id, finalRole, invite.created_by)
          .run()
      }
      // Stamp the invite as used (single-shot). Re-redemption by the same
      // user is still allowed because the WHERE/Math.max guards above run
      // before this UPDATE — `used_by` records the first redeemer only.
      if (!invite.used_at) {
        await c.env.AQUILLA_PG.prepare(
          `UPDATE project_invites
           SET used_by = ?, used_at = CURRENT_TIMESTAMP
           WHERE token = ?`,
        )
          .bind(user.id, token)
          .run()
      }
    } catch (err) {
      console.error("[invites] accept failed:", err)
      return c.json({ error: "Failed to accept invite" }, 500)
    }

    return c.json({ projectId: invite.project_id, role: finalRole })
  },
)

export default projectsInvites
