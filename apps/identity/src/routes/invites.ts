// Multi-project invite routes (Aquilla spec 03-data-model.md §"Project
// invite": "Invite belongs to one Project (single-project invite) or many
// Projects (multi-project invite — multiple project_invites rows share a
// token in the prototype)").
//
// Mounted at /api/v2/invites in src/index.ts. The legacy single-project
// invite endpoints (POST /api/v2/projects/:id/invites,
// POST /api/v2/projects/accept-invite, GET /invite-preview/:token,
// DELETE /:id/invites/:token) continue to live in routes/projects.ts and
// keep working unchanged. This file adds:
//
//   POST /api/v2/invites/multi              mint one token spanning N projects
//   POST /api/v2/invites/:token/accept      redeem (materializes a project_members
//                                            row per row sharing the token)
//   GET  /api/v2/invites/:token/preview     joiner-side prefill (public)
//
// The multi-token surface uses the `(token, project_id)` composite PK from
// migration 0006_multi_project_invites.sql. Per spec, redemption stamps
// `used_by`/`used_at` on every row sharing the token.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  INVITE_MIN_ROLE,
  LINK_ROLE_CAP,
  ROLE,
  type ProjectInviteRow,
  type ProjectRow,
} from "../types"
import {
  isLinkRoleLevel,
  resolveProjectRole,
  ROLE_NAMES,
} from "../services/project-permissions"

const invites = new Hono<AuthHonoEnv>()

// 30-day default lifetime, matching the single-project invite flow in
// routes/projects.ts.
const DEFAULT_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000

function roleNameFor(level: number): string {
  return ROLE_NAMES[level] ?? `level_${level}`
}

function clampLinkRole(level: number): number {
  let n = level
  if (n > LINK_ROLE_CAP) n = LINK_ROLE_CAP
  if (n < ROLE.VIEWER) n = ROLE.VIEWER
  if (!isLinkRoleLevel(n)) n = LINK_ROLE_CAP
  return n
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/invites/multi
//
// Body: { projectIds: string[], roleLevel?: number, expiresAt?: string }
//
// Mints one token; inserts one row per project (sharing the token + role
// + expiry). Caller must hold project_lead+ on every project in the list
// — partial success is not allowed.
// ──────────────────────────────────────────────────────────────────────────

const createMultiInviteSchema = z.object({
  projectIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  roleLevel: z.number().int().min(100).max(700).optional(),
  expiresAt: z.string().datetime().optional(),
})

invites.post(
  "/multi",
  authMiddleware,
  zValidator("json", createMultiInviteSchema),
  async (c) => {
    const user = c.get("user")
    const body = c.req.valid("json")

    // De-dupe before any DB work — clients sometimes accidentally
    // include the same id twice.
    const projectIds = Array.from(new Set(body.projectIds))

    const grantedRole = clampLinkRole(body.roleLevel ?? ROLE.CONTRIBUTOR)

    // Permission check on every project. Bail at the first denial so the
    // caller can't probe project ids by token.
    for (const pid of projectIds) {
      const resolved = await resolveProjectRole(c.env, user, pid)
      if (!resolved) {
        return c.json({ error: `project not found: ${pid}` }, 404)
      }
      if (resolved.level < INVITE_MIN_ROLE) {
        return c.json(
          {
            error: `role >= project_lead required (project ${pid})`,
          },
          403,
        )
      }
    }

    const token = crypto.randomUUID().replace(/-/g, "")
    const expiresAt =
      body.expiresAt ?? new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString()

    for (const pid of projectIds) {
      try {
        await c.env.AQUILLA_DB.prepare(
          `INSERT INTO project_invites
             (token, project_id, role_level, created_by, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(token, pid, grantedRole, user.id, expiresAt)
          .run()
      } catch (err) {
        console.error(`[invites/multi] insert failed for ${pid}:`, err)
        return c.json({ error: "Failed to create multi-project invite" }, 500)
      }
    }

    return c.json({
      token,
      projectIds,
      role: grantedRole,
      expiresAt,
    })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/invites/:token/preview — public; returns the list of project
// names + the shared role so the JoinPage can render a confirmation card
// before the user accepts.
// ──────────────────────────────────────────────────────────────────────────

invites.get("/:token/preview", async (c) => {
  const token = c.req.param("token") as string
  if (!token || token.length < 8) {
    return c.json({ error: "Invalid token" }, 404)
  }

  const rows = await c.env.AQUILLA_DB.prepare(
    `SELECT token, project_id, role_level, created_by, created_at,
            expires_at, used_by, used_at
       FROM project_invites WHERE token = ?`,
  )
    .bind(token)
    .all<ProjectInviteRow>()

  const invitesForToken = rows.results ?? []
  if (invitesForToken.length === 0) {
    return c.json({ error: "Invite not found" }, 404)
  }

  // Expiry / used checks: the shared rows all carry the same expires_at
  // (one writer minted them together). We sample the first.
  const first = invitesForToken[0]
  if (first.expires_at) {
    const expiresAt = new Date(first.expires_at)
    if (expiresAt < new Date()) {
      return c.json({ error: "Invite expired" }, 410)
    }
  }
  // For multi-invites we DO allow re-preview if some rows are unused.
  const allUsed = invitesForToken.every((r) => r.used_at != null)
  if (allUsed) {
    return c.json({ error: "Invite already used" }, 410)
  }

  // Pull project rows in one shot.
  const placeholders = invitesForToken.map(() => "?").join(",")
  const projectRows = await c.env.AQUILLA_DB.prepare(
    `SELECT id, name, org_id, created_by, archived_at
       FROM projects WHERE id IN (${placeholders})`,
  )
    .bind(...invitesForToken.map((r) => r.project_id))
    .all<ProjectRow>()

  const byId = new Map<string, ProjectRow>()
  for (const p of projectRows.results ?? []) byId.set(p.id, p)

  const projects = invitesForToken
    .map((r) => {
      const p = byId.get(r.project_id)
      if (!p) return null
      return {
        projectId: r.project_id,
        projectName: p.name,
        archived: p.archived_at != null,
        usedByCaller: false, // populated only when authed; safe default
      }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  return c.json({
    token,
    role: { level: first.role_level, name: roleNameFor(first.role_level) },
    expiresAt: first.expires_at,
    projects,
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/invites/:token/accept
//
// Materializes a project_members row for EVERY project sharing the token.
// Stamps used_by / used_at on every row. If the caller is already a
// member of any project with a higher role, that row's role is preserved
// (never demote on accept).
// ──────────────────────────────────────────────────────────────────────────

invites.post("/:token/accept", authMiddleware, async (c) => {
  const user = c.get("user")
  const token = c.req.param("token") as string

  const rows = await c.env.AQUILLA_DB.prepare(
    `SELECT token, project_id, role_level, created_by, created_at,
            expires_at, used_by, used_at
       FROM project_invites WHERE token = ?`,
  )
    .bind(token)
    .all<ProjectInviteRow>()

  const invitesForToken = rows.results ?? []
  if (invitesForToken.length === 0) {
    return c.json({ error: "Invite not found" }, 404)
  }

  // Expiry check (sampled from first row; they all share expires_at).
  const first = invitesForToken[0]
  if (first.expires_at) {
    const expiresAt = new Date(first.expires_at)
    if (expiresAt < new Date()) {
      return c.json({ error: "Invite expired" }, 410)
    }
  }

  const accepted: Array<{ projectId: string; role: number }> = []

  for (const invite of invitesForToken) {
    // Allow re-acceptance only when used_by is the same caller — matches
    // the single-project semantics in routes/projects.ts.
    if (invite.used_at && invite.used_by !== user.id) {
      // Some rows may have been used by another user already; skip
      // those silently rather than 410-ing the whole multi-accept. The
      // remaining unused rows still flow.
      continue
    }

    const existing = await c.env.AQUILLA_DB.prepare(
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
        await c.env.AQUILLA_DB.prepare(
          `UPDATE project_members
              SET role_level = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
            WHERE project_id = ? AND user_id = ?`,
        )
          .bind(finalRole, invite.created_by, invite.project_id, user.id)
          .run()
      } else {
        await c.env.AQUILLA_DB.prepare(
          `INSERT INTO project_members
             (project_id, user_id, role_level, granted_by)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(invite.project_id, user.id, finalRole, invite.created_by)
          .run()
      }
      if (!invite.used_at) {
        await c.env.AQUILLA_DB.prepare(
          `UPDATE project_invites
              SET used_by = ?, used_at = CURRENT_TIMESTAMP
            WHERE token = ? AND project_id = ?`,
        )
          .bind(user.id, token, invite.project_id)
          .run()
      }
    } catch (err) {
      console.error(
        `[invites/multi] accept failed for ${invite.project_id}:`,
        err,
      )
      return c.json({ error: "Failed to accept invite" }, 500)
    }

    accepted.push({ projectId: invite.project_id, role: finalRole })
  }

  if (accepted.length === 0) {
    return c.json({ error: "Invite already used" }, 410)
  }

  return c.json({ token, accepted })
})

export default invites
