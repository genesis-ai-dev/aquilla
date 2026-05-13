// POST /api/v2/sync-token — mints a short-lived JWT for codex-sync-worker.
//
// Spec: docs/SYNC.md ("The flow (single-user, single-file)") in this repo.
//
// Request: { projectId, fileId, projectName?, gitlabProjectId? } + Bearer JWT.
// Response: { token, expiresIn: 900, role: { level, name, source } }.
//
// Token claims must match codex-sync-worker/src/auth.ts SyncTokenClaims:
//   { userId, username, projectId, fileId, role, aud: "sync", iat, exp }
// Signed HS256 with SYNC_SECRET_KEY (distinct from SECRET_KEY).
//
// Role resolution priority:
//   1. project_members override (D1).
//   2. Implicit creator: row in `projects` where `created_by = me` => OWNER.
//   3. Auto-register: if projectId is unknown AND a bootstrap payload was
//      sent, insert a `projects` row owned by the caller and grant OWNER.
//   4. Fall through => 403. (GitLab membership fallback is intentionally
//      deferred — without it, joiners must be added via /accept-invite.)

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { sign } from "hono/jwt"
import { authMiddleware } from "../middleware/auth"
import type { AuthHonoEnv } from "../middleware/auth"
import {
  ROLE,
  type ProjectRow,
  type RoleResolution,
  type SyncTokenClaims,
  type SyncTokenResponse,
} from "../types"

const syncToken = new Hono<AuthHonoEnv>()

const syncTokenSchema = z.object({
  projectId: z.string().min(1),
  fileId: z.string().min(1),
  // Optional bootstrap so an unknown projectId can be auto-registered
  // on the caller's first request.
  projectName: z.string().optional(),
  gitlabProjectId: z.number().int().optional(),
})

// 15-minute lifetime — matches the value documented in docs/SYNC.md.
const SYNC_TOKEN_TTL_SECONDS = 15 * 60

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

syncToken.post(
  "/",
  authMiddleware,
  zValidator("json", syncTokenSchema),
  async (c) => {
    if (!c.env.SYNC_SECRET_KEY) {
      return c.json({ error: "SYNC_SECRET_KEY not configured" }, 503)
    }
    const user = c.get("user")
    const { projectId, fileId, projectName, gitlabProjectId } =
      c.req.valid("json")

    const project = await c.env.AUTH_DB.prepare(
      `SELECT id, name, gitlab_project_id, org_id, created_by, archived_at
       FROM projects WHERE id = ?`,
    )
      .bind(projectId)
      .first<ProjectRow>()

    let resolved: RoleResolution | null = null

    if (project) {
      if (project.archived_at) {
        return c.json({ error: "Project is archived" }, 403)
      }

      // 1. project_members override.
      const member = await c.env.AUTH_DB.prepare(
        `SELECT role_level FROM project_members
         WHERE project_id = ? AND user_id = ?`,
      )
        .bind(projectId, user.id)
        .first<{ role_level: number }>()
      if (member) {
        resolved = {
          level: member.role_level,
          name: roleNameFor(member.role_level),
          source: "override",
        }
      }

      // 2. Implicit creator.
      if (!resolved && project.created_by === user.id) {
        resolved = {
          level: ROLE.OWNER,
          name: roleNameFor(ROLE.OWNER),
          source: "creator",
        }
      }
    } else if (projectName) {
      // 3. Auto-register an unknown projectId. The bootstrap payload (project
      //    name, optional gitlab project id) is supplied by the client; the
      //    caller becomes the owner. Matches the auto-registration behaviour
      //    described in docs/SYNC.md.
      try {
        await c.env.AUTH_DB.prepare(
          `INSERT INTO projects (id, name, gitlab_project_id, created_by)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(projectId, projectName, gitlabProjectId ?? null, user.id)
          .run()
        resolved = {
          level: ROLE.OWNER,
          name: roleNameFor(ROLE.OWNER),
          source: "creator",
        }
      } catch (err) {
        console.error("[sync-token] auto-register failed:", err)
        return c.json({ error: "Failed to register project" }, 500)
      }
    }

    if (!resolved) {
      return c.json({ error: "No access to project" }, 403)
    }

    const now = Math.floor(Date.now() / 1000)
    const claims: SyncTokenClaims = {
      userId: user.id,
      username: user.username,
      projectId,
      fileId,
      role: resolved.level,
      aud: "sync",
      iat: now,
      exp: now + SYNC_TOKEN_TTL_SECONDS,
    }
    const token = await sign(
      claims as unknown as Record<string, unknown>,
      c.env.SYNC_SECRET_KEY,
      "HS256",
    )
    const response: SyncTokenResponse = {
      token,
      expiresIn: SYNC_TOKEN_TTL_SECONDS,
      role: resolved,
    }
    return c.json(response)
  },
)

export default syncToken
