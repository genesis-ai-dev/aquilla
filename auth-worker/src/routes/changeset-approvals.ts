// One-time human approval assertion for ask-mode changesets (AQU-533 §3).
// Mounted at /api/v2/changesets in src/index.ts.
//
//   GET  /:id/approval          load a changeset for the approval page
//   POST /:id/approve           mint a one-time confirmation (idempotent)
//   POST /:id/reject            discard a staged changeset
//   POST /:id/assign            route a staged changeset to a project member
//
// All endpoints sit behind authMiddleware (browser session JWT) — this is the
// human-approval surface, distinct from the API-credential-authenticated
// agent surface in sync-worker/src/external/*.
//
// AuthZ (AQU-CMDREG-P1 §2.1): authority, not identity. A caller may view /
// approve / reject when their LIVE project role is at or above the floor the
// plan was staged against (recomputed from the stored commands — see
// lib/changeset-floor.ts). The invariant that does NOT change: an agent
// proposes, a human approves — approval still consumes a browser session, and
// no agent surface can mint a confirmation. The proposer is deliberately NOT
// excluded from approving: the shipped in-app flow is one person running the
// agent and applying its output.
//
// Error envelope mirrors sync-worker's external error contract
// (sync-worker/src/external/errors.ts): `{ error: { code, message, details? } }`
// with the same stable codes so an agent/UI can branch consistently across
// both workers.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { planIsCreatorScoped, requiredRoleForChangeset } from "../lib/changeset-floor"
import { resolveProjectRole } from "../services/project-permissions"
import { ROLE, type AuthUser, type Env } from "../types"
import { buildChangeDetails } from "../lib/changeset-approval-changes"

const changesetApprovals = new Hono<AuthHonoEnv>()

/** One-time confirmation lifetime, matching sync-worker's commit-side check. */
const CONFIRMATION_TTL_MS = 15 * 60 * 1000

type ErrorCode =
  | "not_found"
  | "permission_denied"
  | "validation_failed"

function errorJson(code: ErrorCode, message: string, details?: unknown) {
  const status = code === "not_found" ? 404 : code === "permission_denied" ? 403 : 409
  return { body: { error: { code, message, ...(details !== undefined ? { details } : {}) } }, status } as const
}

interface ChangesetRow {
  id: string
  project_id: string
  project_name: string | null
  created_by_user_id: string
  credential_id: string
  autonomy_mode: string
  status: string
  commands: unknown
  summary: unknown
  digest: string
  created_at: unknown
  expires_at: unknown
  assigned_to_user_id: string | null
}

function toIso(v: unknown): string {
  if (v == null) return ""
  if (v instanceof Date) return v.toISOString()
  return new Date(v as string).toISOString()
}

function parseJson<T>(v: unknown): T {
  if (v == null) return v as T
  if (typeof v === "string") return JSON.parse(v) as T
  return v as T
}

async function loadChangeset(
  db: AuthHonoEnv["Bindings"]["AQUILLA_PG"],
  id: string,
): Promise<ChangesetRow | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.project_id, p.name AS project_name, c.created_by_user_id,
              c.credential_id, c.autonomy_mode, c.status, c.commands, c.summary,
              c.digest, c.created_at, c.expires_at, c.assigned_to_user_id
         FROM changesets c
         LEFT JOIN projects p ON p.id = c.project_id
        WHERE c.id = ?`,
    )
    .bind(id)
    .first<ChangesetRow>()
  return row ?? null
}

function floorDenied(required: number, verb: string) {
  return errorJson(
    "permission_denied",
    `role ${required}+ on this changeset's project is required to ${verb} it`,
    { requiredRole: required },
  )
}

/**
 * Approval authority (P1 §2.1). The caller's LIVE project role must be at or
 * above the floor the plan was staged against. A caller with no role on the
 * changeset's project resolves to null and is denied — that is also the
 * cross-tenant guard, since this route is keyed by changeset id alone, and it
 * covers the [Pen test] Authorization & access control finding (2026-08-18):
 * having staged a changeset in the past must not resurrect access after the
 * caller's project standing ends, on reads (cell text on the approval page)
 * or writes alike.
 *
 * Returns the denial envelope, or null when the caller may act.
 */
async function authorityDenied(
  env: Env,
  user: AuthUser,
  cs: ChangesetRow,
  verb: string,
): Promise<ReturnType<typeof errorJson> | null> {
  // Org-level plans keep the creator rule: a project-creation plan's project
  // does not exist until commit, and an org-membership plan (AQU-1235) does not
  // concern the project it is filed under — so no project role resolves against
  // either and a floor would deny everyone. Their real gate is the org-role
  // check at prepare/commit.
  if (planIsCreatorScoped(cs.commands)) {
    if (cs.created_by_user_id === String(user.id)) return null
    return errorJson(
      "permission_denied",
      `only the creator of an org-level plan may ${verb} it`,
    )
  }
  const required = await requiredRoleForChangeset(env, cs.project_id, cs.commands)
  const role = await resolveProjectRole(env, user, cs.project_id)
  if (!role || role.level < required) return floorDenied(required, verb)
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// GET /:id/approval
// ──────────────────────────────────────────────────────────────────────────

changesetApprovals.get("/:id/approval", authMiddleware, async (c) => {
  const user = c.get("user")
  const id = c.req.param("id") ?? ""

  const cs = await loadChangeset(c.env.AQUILLA_PG, id)
  if (!cs) {
    const { body, status } = errorJson("not_found", `changeset ${id} not found`)
    return c.json(body, status)
  }
  const denied = await authorityDenied(c.env, user, cs, "view")
  if (denied) return c.json(denied.body, denied.status)

  const details = await buildChangeDetails(c.env.AQUILLA_PG, cs.project_id, cs.commands)

  return c.json({
    changesetId: cs.id,
    projectId: cs.project_id,
    projectName: cs.project_name,
    status: cs.status,
    autonomyMode: cs.autonomy_mode,
    summary: parseJson<unknown>(cs.summary),
    ...details,
    // Routing only — an assignee never changes the status (P1 §2.2).
    assignedToUserId: cs.assigned_to_user_id,
    digest: cs.digest,
    createdAt: toIso(cs.created_at),
    expiresAt: toIso(cs.expires_at),
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /:id/approve
// ──────────────────────────────────────────────────────────────────────────

const approveSchema = z.object({ digest: z.string().min(1) })

changesetApprovals.post(
  "/:id/approve",
  authMiddleware,
  zValidator("json", approveSchema),
  async (c) => {
    const user = c.get("user")
    const id = c.req.param("id") ?? ""
    const { digest } = c.req.valid("json")
    const db = c.env.AQUILLA_PG

    const cs = await loadChangeset(db, id)
    if (!cs) {
      const { body, status } = errorJson("not_found", `changeset ${id} not found`)
      return c.json(body, status)
    }
    const denied = await authorityDenied(c.env, user, cs, "approve")
    if (denied) return c.json(denied.body, denied.status)
    if (cs.status !== "staged") {
      const { body, status } = errorJson(
        "validation_failed",
        `changeset is ${cs.status}, not staged`,
      )
      return c.json(body, status)
    }
    if (new Date(toIso(cs.expires_at)).getTime() < Date.now()) {
      const { body, status } = errorJson("validation_failed", "changeset has expired")
      return c.json(body, status)
    }
    if (digest !== cs.digest) {
      const { body, status } = errorJson(
        "validation_failed",
        "digest mismatch — the plan you're approving doesn't match the staged changeset",
        { code: "digest_mismatch" },
      )
      return c.json(body, status)
    }

    // Idempotent: an unconsumed, unexpired confirmation already exists for
    // this changeset — return it rather than minting a duplicate.
    const existing = await db
      .prepare(
        `SELECT id, expires_at FROM changeset_confirmations
          WHERE changeset_id = ? AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(id)
      .first<{ id: string; expires_at: unknown }>()
    if (existing) {
      return c.json({
        confirmationId: existing.id,
        expiresAt: toIso(existing.expires_at),
        message: "Approval already recorded — the agent may now call commit/confirm_changeset.",
      })
    }

    const confirmationId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString()
    await db
      .prepare(
        `INSERT INTO changeset_confirmations
            (id, changeset_id, user_id, credential_id, digest, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(confirmationId, id, String(user.id), cs.credential_id, digest, expiresAt)
      .run()

    return c.json({
      confirmationId,
      expiresAt,
      message: "Approved — the agent may now call commit/confirm_changeset.",
    })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// POST /:id/reject
// ──────────────────────────────────────────────────────────────────────────

changesetApprovals.post("/:id/reject", authMiddleware, async (c) => {
  const user = c.get("user")
  const id = c.req.param("id") ?? ""
  const db = c.env.AQUILLA_PG

  const cs = await loadChangeset(db, id)
  if (!cs) {
    const { body, status } = errorJson("not_found", `changeset ${id} not found`)
    return c.json(body, status)
  }
  const denied = await authorityDenied(c.env, user, cs, "reject")
  if (denied) return c.json(denied.body, denied.status)
  if (cs.status === "discarded") {
    return c.json({ changesetId: cs.id, status: "discarded" })
  }
  if (cs.status !== "staged") {
    const { body, status } = errorJson(
      "validation_failed",
      `changeset is ${cs.status}, not staged`,
    )
    return c.json(body, status)
  }

  await db.prepare(`UPDATE changesets SET status = 'discarded' WHERE id = ?`).bind(id).run()
  return c.json({ changesetId: cs.id, status: "discarded" })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /:id/assign  (AQU-CMDREG-P1 §2.2)
// ──────────────────────────────────────────────────────────────────────────

const assignSchema = z.object({ userId: z.string().min(1).nullable() })

/** True when `userId` names a LIVE member of the project — any surviving
 *  AD-12 grant path, not just a direct project_members row. False when the id
 *  names no user: routing a plan at somebody who cannot act on it is a
 *  validation failure, not a silent no-op. (The full row is loaded because
 *  resolveProjectRole re-resolves from it — same idiom as routes/projects.ts.) */
async function isLiveProjectMember(
  env: Env,
  userId: string,
  projectId: string,
): Promise<boolean> {
  if (!/^\d+$/.test(userId)) return false
  const assignee = await env.AQUILLA_PG.prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(Number(userId))
    .first<AuthUser>()
  if (!assignee) return false
  return (await resolveProjectRole(env, assignee, projectId)) !== null
}

changesetApprovals.post(
  "/:id/assign",
  authMiddleware,
  zValidator("json", assignSchema),
  async (c) => {
    const user = c.get("user")
    const id = c.req.param("id") ?? ""
    const { userId } = c.req.valid("json")
    const db = c.env.AQUILLA_PG

    const cs = await loadChangeset(db, id)
    if (!cs) {
      const { body, status } = errorJson("not_found", `changeset ${id} not found`)
      return c.json(body, status)
    }

    // Routing is a lead action, so it carries its OWN floor (PROJECT_LEAD),
    // independent of the plan's approval floor.
    const role = await resolveProjectRole(c.env, user, cs.project_id)
    if (!role || role.level < ROLE.PROJECT_LEAD) {
      const { body, status } = floorDenied(ROLE.PROJECT_LEAD, "assign")
      return c.json(body, status)
    }

    if (userId !== null && !(await isLiveProjectMember(c.env, userId, cs.project_id))) {
      const { body, status } = errorJson(
        "validation_failed",
        "assignee must be a live member of this changeset's project",
      )
      return c.json(body, status)
    }

    // Assignment NEVER resolves anything: a staged changeset with an assignee
    // is still staged, and `null` clears the routing. The status column is
    // deliberately untouched here.
    await db
      .prepare(`UPDATE changesets SET assigned_to_user_id = ? WHERE id = ?`)
      .bind(userId, id)
      .run()

    return c.json({ changesetId: cs.id, assignedToUserId: userId, status: cs.status })
  },
)

export default changesetApprovals
