// AQU-553 (Slice 5): per-member lane/file scopes — additive write restrictions
// layered on top of a member's role floor.
//
//   GET /api/v2/projects/:projectId/members/:userId/scopes
//       Read a member's scopes. A member may read their OWN scopes (viewer
//       100+); reading someone else's requires project_lead (500+).
//
//   PUT /api/v2/projects/:projectId/members/:userId/scopes
//       Replace-set a member's scopes (project_lead 500+). Body:
//         { scopes: Array<{ kind: 'lane' | 'file', value: string }> }
//       An empty array clears all scopes (unscoped = today's behavior).
//       Scoping a user whose effective role is >= 500 is rejected with 400 —
//       leads/maintainers/owners must stay unscoped.
//
// Registered in index.ts under the /api/v2/projects prefix. The scopes table
// (project_member_scopes) is loaded at sync-token mint time into the token's
// `scopes` claim, and enforced in sync-worker authorize.

import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { listEffectiveProjectMembers } from "../services/org-permissions"

const memberScopes = new Hono<AuthHonoEnv>()

const paramsSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().regex(/^\d+$/),
})

/**
 * AQU-581: the GET route additionally accepts the literal `me`, resolved from
 * the authenticated token. Without it a caller must already know their own
 * numeric id, and the only client-side source for that is the project roster —
 * which `rosterViewMinRole` hides from contributors by default. That made a
 * lane delegate's own scopes unreadable by the very role the delegation is
 * for, so the assign UI never appeared even with the org setting on.
 *
 * Reading your own scopes needs no extra authority: the self-read allowance
 * below already permits it, and `me` cannot name anyone else. PUT keeps the
 * strict numeric schema — writing scopes is project_lead-only and always
 * targets an explicit member.
 */
const getParamsSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().regex(/^(?:\d+|me)$/),
})

const scopeSchema = z.object({
  kind: z.enum(["lane", "file"]),
  value: z.string(),
})

const putBodySchema = z.object({
  scopes: z.array(scopeSchema),
})

export interface MemberScope {
  kind: "lane" | "file"
  value: string
}

/**
 * Whether the project's org lets lane-limited members assign work to others
 * (`allowScopedLaneAssignment`, AQU-581). It rides on the caller's OWN scopes
 * response because a GUEST — a project member outside the org, the natural
 * shape of an outside mentor — can't read the org's settings (403), so the
 * client read the setting as off and hid "Assign work" the server would have
 * allowed. A boolean policy about the caller themselves; nothing else leaks.
 * Fail-safe: no org, no row, or unreadable settings → false.
 */
async function loadLaneAssignmentAllowed(env: AuthHonoEnv["Bindings"], projectId: string): Promise<boolean> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT s.settings FROM projects p JOIN org_settings s ON s.org_id = p.org_id WHERE p.id = ?",
  )
    .bind(projectId)
    .first<{ settings: string }>()
  if (!row) return false
  try {
    return (JSON.parse(row.settings) as { allowScopedLaneAssignment?: unknown })?.allowScopedLaneAssignment === true
  } catch {
    return false
  }
}

async function loadScopes(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
  userId: number,
): Promise<MemberScope[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT kind, value FROM project_member_scopes WHERE project_id = ? AND user_id = ? ORDER BY kind, value",
  )
    .bind(projectId, userId)
    .all<{ kind: "lane" | "file"; value: string }>()
  return (rows.results ?? []).map((r) => ({ kind: r.kind, value: r.value }))
}

/**
 * GET /api/v2/projects/:projectId/members/:userId/scopes
 *
 * Own scopes: viewer (100+). Others' scopes: project_lead (500+).
 */
memberScopes.get(
  "/:projectId/members/:userId/scopes",
  authMiddleware,
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const rawUserId = c.req.param("userId") as string

    const parsed = getParamsSchema.safeParse({ projectId, userId: rawUserId })
    if (!parsed.success) return c.json({ error: "invalid params" }, 400)
    const targetUserId = rawUserId === "me" ? user.id : parseInt(rawUserId, 10)

    const callerRole = await resolveProjectRole(c.env, user, projectId)
    if (!callerRole || callerRole.level < ROLE.VIEWER) {
      return c.json({ error: "no access to project" }, 403)
    }
    // Reading someone ELSE's scopes requires project_lead (500+).
    if (targetUserId !== user.id && callerRole.level < ROLE.PROJECT_LEAD) {
      return c.json({ error: "project_lead required to view others' scopes" }, 403)
    }

    const scopes = await loadScopes(c.env, projectId, targetUserId)
    // A member asking about THEMSELVES also learns whether the org lets
    // lane-limited members assign work — see loadLaneAssignmentAllowed.
    if (rawUserId === "me") {
      return c.json({ scopes, allowScopedLaneAssignment: await loadLaneAssignmentAllowed(c.env, projectId) })
    }
    return c.json({ scopes })
  },
)

/**
 * PUT /api/v2/projects/:projectId/members/:userId/scopes
 *
 * Replace-set the target member's scopes. Requires project_lead (500+).
 * Rejects scoping a member whose effective role is >= 500.
 */
memberScopes.put(
  "/:projectId/members/:userId/scopes",
  authMiddleware,
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const rawUserId = c.req.param("userId") as string

    const parsedParams = paramsSchema.safeParse({ projectId, userId: rawUserId })
    if (!parsedParams.success) return c.json({ error: "invalid params" }, 400)
    const targetUserId = parseInt(rawUserId, 10)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    const parsedBody = putBodySchema.safeParse(body)
    if (!parsedBody.success) {
      return c.json({ error: "invalid scopes payload" }, 400)
    }
    const scopes = parsedBody.data.scopes

    const callerRole = await resolveProjectRole(c.env, user, projectId)
    if (!callerRole) return c.json({ error: "no access to project" }, 403)
    if (callerRole.level < ROLE.PROJECT_LEAD) {
      return c.json({ error: "project_lead required to manage scopes" }, 403)
    }

    // Project must exist (also gives org/creator context for role resolution).
    const projectRow = await c.env.AQUILLA_PG.prepare(
      "SELECT id, created_by, org_id FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ id: string; created_by: number; org_id: number | null }>()
    if (!projectRow) return c.json({ error: "project not found" }, 404)

    // Leads must stay unscoped: reject scoping any member whose EFFECTIVE role
    // is at or above PROJECT_LEAD (500). Scopes are for contributor/reviewer.
    // An empty replace-set (clearing) is always allowed regardless of role.
    if (scopes.length > 0) {
      const effectiveMembers = await listEffectiveProjectMembers(
        c.env,
        projectId,
        projectRow.org_id,
        projectRow.created_by,
      )
      const target = effectiveMembers.find((m) => m.userId === targetUserId)
      if (target && target.roleLevel >= ROLE.PROJECT_LEAD) {
        return c.json(
          { error: "scopes are for contributor/reviewer roles" },
          400,
        )
      }
    }

    // Replace-set: clear then re-insert. The scopes table has no other writers
    // for this (project, user), so a delete-then-insert pair is atomic enough
    // for the single-writer D1/Postgres model.
    await c.env.AQUILLA_PG.prepare(
      "DELETE FROM project_member_scopes WHERE project_id = ? AND user_id = ?",
    )
      .bind(projectId, targetUserId)
      .run()

    // De-dup on (kind, value) — the PK would reject dupes, but a client could
    // send them; collapse so the insert loop doesn't error mid-batch.
    const seen = new Set<string>()
    const now = Date.now()
    for (const s of scopes) {
      const key = `${s.kind}\u0000${s.value}`
      if (seen.has(key)) continue
      seen.add(key)
      await c.env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(projectId, targetUserId, s.kind, s.value, String(user.id), now)
        .run()
    }

    const saved = await loadScopes(c.env, projectId, targetUserId)
    return c.json({ scopes: saved })
  },
)

export default memberScopes
