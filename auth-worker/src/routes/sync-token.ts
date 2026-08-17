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
// AQU-926: the mint core (freeze checks + AD-12 role resolution + scope load
// + sign) lives in services/sync-token-mint.ts, shared with the agent
// harness's propose_command tool. Auto-register (when projectId is unknown
// AND a bootstrap payload was sent) stays here because it's a
// project-creation path, not a resolution path; the inserted creator grant
// resolves to OWNER on the next refresh.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import type { AuthHonoEnv } from "../middleware/auth"
import { ROLE, type RoleResolution, type SyncTokenResponse } from "../types"
import {
  mintSyncTokenForUser,
  roleNameFor,
  signSyncTokenWithRole,
} from "../services/sync-token-mint"

const syncToken = new Hono<AuthHonoEnv>()

const syncTokenSchema = z.object({
  projectId: z.string().min(1),
  fileId: z.string().min(1),
  // Optional bootstrap so an unknown projectId can be auto-registered
  // on the caller's first request.
  projectName: z.string().optional(),
})

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

    const minted = await mintSyncTokenForUser(c.env, user, projectId, fileId)
    if (minted.ok) {
      const response: SyncTokenResponse = {
        token: minted.token,
        expiresIn: minted.expiresIn,
        role: minted.role,
      }
      return c.json(response)
    }

    switch (minted.reason) {
      case "not_configured":
        return c.json({ error: "SYNC_SECRET_KEY not configured" }, 503)
      case "project_archived":
        return c.json({ error: "Project is archived" }, 403)
      // AQU-285: frozen projects block new write-capable token mints. Token
      // TTL is 15 min, so a mint-time check is sufficient; reads use
      // GET /cells, not sync-token, so only writes are blocked.
      case "project_frozen":
        return c.json({ error: "Project is frozen" }, 403)
      case "project_not_found": {
        if (!projectName) {
          return c.json({ error: "No access to project" }, 403)
        }
        // Auto-register an unknown projectId. The bootstrap payload (project
        // name) is supplied by the client; the caller becomes the owner.
        // Matches the auto-registration behaviour described in docs/SYNC.md.
        try {
          await c.env.AQUILLA_PG.prepare(
            `INSERT INTO projects (id, name, created_by)
             VALUES (?, ?, ?)`,
          )
            .bind(projectId, projectName, user.id)
            .run()
        } catch (err) {
          console.error("[sync-token] auto-register failed:", err)
          return c.json({ error: "Failed to register project" }, 500)
        }
        const resolved: RoleResolution = {
          level: ROLE.OWNER,
          name: roleNameFor(ROLE.OWNER),
          source: "creator",
        }
        const signed = await signSyncTokenWithRole(c.env, user, projectId, fileId, resolved)
        const response: SyncTokenResponse = {
          token: signed.token,
          expiresIn: signed.expiresIn,
          role: resolved,
        }
        return c.json(response)
      }
      case "no_access":
        return c.json({ error: "No access to project" }, 403)
    }
  },
)

export default syncToken
