// POST /api/v2/sync-token — mints a short-lived JWT for aquilla-sync-worker.
//
// Spec: docs/SYNC.md ("The flow (single-user, single-file)") in this repo.
//
// Request: { projectId, fileId, projectName? } + Bearer JWT.
// Response: { token, expiresIn: 900, role: { level, name, source } }.
//
// Token claims must match apps/sync/src/auth.ts SyncTokenClaims:
//   { userId, username, projectId, fileId, role, aud: "sync", iat, exp }
// Signed HS256 with SYNC_SECRET_KEY (distinct from SECRET_KEY).
//
// Role resolution: delegates to project-permissions.resolveProjectRole,
// which implements AD-12 max-wins across direct + group + org + creator
// paths. Auto-register (when projectId is unknown AND a bootstrap payload
// was sent) stays here because it's a project-creation path, not a
// resolution path; the inserted creator grant resolves to OWNER on the
// next refresh.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { sign } from "hono/jwt"
import { authMiddleware } from "../middleware/auth"
import type { AuthHonoEnv } from "../middleware/auth"
import {
  ROLE,
  type RoleResolution,
  type SyncTokenClaims,
  type SyncTokenResponse,
} from "../types"
import { resolveProjectRole } from "../services/project-permissions"

const syncToken = new Hono<AuthHonoEnv>()

const syncTokenSchema = z.object({
  projectId: z.string().min(1),
  fileId: z.string().min(1),
  // Optional bootstrap so an unknown projectId can be auto-registered
  // on the caller's first request.
  projectName: z.string().optional(),
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
    const { projectId, fileId, projectName } = c.req.valid("json")

    // Cheap existence + lifecycle check first so we can short-circuit on
    // archived/frozen and branch to auto-register when the project is unknown.
    //
    // FRO-285 (Open Question 11): is_active=false means "frozen/dormant" per
    // the schema comment. Token TTL is 15 min (SYNC_TOKEN_TTL_SECONDS=900), so
    // a mint-time check is sufficient — any token minted before a freeze
    // expires within 15 min naturally. Reads are not blocked by the sync-token
    // path (clients use GET /cells, not sync-token, for read-only access), so
    // rejecting here only blocks write-capable token mints.
    const project = await c.env.AQUILLA_PG.prepare(
      `SELECT id, archived_at, is_active FROM projects WHERE id = ?`,
    )
      .bind(projectId)
      .first<{ id: string; archived_at: string | null; is_active: boolean }>()

    let resolved: RoleResolution | null = null

    if (project) {
      if (project.archived_at) {
        return c.json({ error: "Project is archived" }, 403)
      }
      // FRO-285: frozen projects block new write-capable token mints.
      // is_active is a BOOLEAN NOT NULL DEFAULT TRUE column (migration 0033).
      if (!project.is_active) {
        return c.json({ error: "Project is frozen" }, 403)
      }
      // AD-12 max-wins across direct + group + org + creator.
      resolved = await resolveProjectRole(c.env, user, projectId)
    } else if (projectName) {
      // 3. Auto-register an unknown projectId. The bootstrap payload (project
      //    name) is supplied by the client; the caller becomes the owner.
      //    Matches the auto-registration behaviour described in docs/SYNC.md.
      try {
        await c.env.AQUILLA_PG.prepare(
          `INSERT INTO projects (id, name, created_by)
           VALUES (?, ?, ?)`,
        )
          .bind(projectId, projectName, user.id)
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
