// FRO-180: Per-project members management — atomic revoke-all endpoint.
//
// This file adds only the NEW endpoint that projects.ts doesn't already have:
//
//   POST /api/v2/projects/:projectId/members/:userId/revoke-all
//
// Direct add / change-role / remove live in auth-worker/src/routes/projects.ts
// (GET/POST/DELETE /api/v2/projects/:projectId/members and
//  DELETE /api/v2/projects/:projectId/members/:userId) — those are NOT repeated
// here. This file is registered in index.ts under the /api/v2/projects prefix.
//
// Revoke-all semantics:
//   - Only works for the caller's direct project_members row (source=override).
//   - Org/group/creator paths confer access server-side and cannot be removed
//     from this surface; the response body lists them so the UI can explain.
//   - Requires MAINTAINER (600) or OWNER (700) on the project.
//   - The endpoint is idempotent: if there is no direct row it returns
//     { removed: false, grantPaths: [...] } (not an error).

import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { listEffectiveProjectMembers } from "../services/org-permissions"
import { notifySyncWorkerOfMemberRemoval } from "../services/sync-worker-notify"

const projectMembers = new Hono<AuthHonoEnv>()

const revokeAllParams = z.object({
  projectId: z.string().min(1),
  userId: z.string().regex(/^\d+$/),
})

/**
 * POST /api/v2/projects/:projectId/members/:userId/revoke-all
 *
 * Atomically removes the target user's direct project_members row (if any)
 * and returns every remaining contributing grant path so the UI can inform
 * the caller that org/group/creator grants still confer access.
 *
 * Body: {} (no payload needed; all info comes from URL params).
 *
 * Requires: caller has MAINTAINER (600)+ on the project.
 *           Caller cannot revoke their own access (server rejects self-targets
 *           to prevent accidental lock-out of the last owner).
 */
projectMembers.post(
  "/:projectId/members/:userId/revoke-all",
  authMiddleware,
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const rawUserId = c.req.param("userId") as string

    const parsed = revokeAllParams.safeParse({ projectId, userId: rawUserId })
    if (!parsed.success) {
      return c.json({ error: "invalid params" }, 400)
    }
    const targetUserId = parseInt(rawUserId, 10)

    // Self-revoke guard: prevents the last owner from accidentally locking
    // themselves out.
    if (user.id === targetUserId) {
      return c.json({ error: "cannot revoke your own access" }, 403)
    }

    const callerRole = await resolveProjectRole(c.env, user, projectId)
    if (!callerRole) return c.json({ error: "no access to project" }, 403)
    if (callerRole.level < ROLE.MAINTAINER) {
      return c.json({ error: "maintainer+ required to revoke access" }, 403)
    }

    // Load the project's owner/org context so we can enumerate grant paths.
    const projectRow = await c.env.AQUILLA_PG.prepare(
      "SELECT id, created_by, org_id FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ id: string; created_by: number; org_id: number | null }>()
    if (!projectRow) return c.json({ error: "project not found" }, 404)

    // Enumerate ALL grant paths for the target via the same function the
    // GET /members endpoint uses — this gives us winner + secondarySources.
    const effectiveMembers = await listEffectiveProjectMembers(
      c.env,
      projectId,
      projectRow.org_id,
      projectRow.created_by,
    )
    const targetMember = effectiveMembers.find((m) => m.userId === targetUserId)

    // Build a list of every grant path the target has (for the UI).
    type GrantPath = {
      source: string
      level: number
      name: string
      removable: boolean
      hint?: string
    }
    const grantPaths: GrantPath[] = []
    if (targetMember) {
      const allSources = [
        { source: targetMember.source, level: targetMember.roleLevel },
        ...targetMember.secondarySources.map((s) => ({
          source: s.source,
          level: s.level,
        })),
      ]
      for (const src of allSources) {
        grantPaths.push({
          source: src.source,
          level: src.level,
          name: roleNameFor(src.level),
          removable: src.source === "override",
          hint:
            src.source === "org"
              ? "Remove from org to revoke org-level access"
              : src.source === "group"
                ? "Remove from the group that grants this access"
                : src.source === "creator"
                  ? "Project creator — cannot be removed"
                  : undefined,
        })
      }
    }

    // Remove the direct project_members row (if any).
    const existing = await c.env.AQUILLA_PG.prepare(
      "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
    )
      .bind(projectId, targetUserId)
      .first<{ 1: number }>()

    let removed = false
    if (existing) {
      await c.env.AQUILLA_PG.prepare(
        "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
      )
        .bind(projectId, targetUserId)
        .run()
      removed = true
    }

    // FRO-346: when the direct row was removed AND no other grant path
    // remains, eject the user's live WS sessions + denylist their
    // still-valid sync tokens. Skipped when an org/group/creator path still
    // confers access — they are still a member via that path. Best-effort.
    const survivingPaths = grantPaths.filter((p) => p.source !== "override")
    if (removed && survivingPaths.length === 0) {
      const targetUser = await c.env.AQUILLA_PG.prepare(
        "SELECT username FROM users WHERE id = ?",
      )
        .bind(targetUserId)
        .first<{ username: string }>()
      const notifyPromise = notifySyncWorkerOfMemberRemoval(c.env, projectId, {
        userId: targetUserId,
        username: targetUser?.username,
      })
      // waitUntil only exists with a real ExecutionContext (prod); the test
      // harness has none and the getter throws — let the promise settle.
      try {
        c.executionCtx.waitUntil(notifyPromise)
      } catch {
        void notifyPromise
      }
    }

    return c.json({ removed, grantPaths })
  },
)

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

export default projectMembers
