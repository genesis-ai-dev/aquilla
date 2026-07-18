// One-time human approval assertion for ask-mode changesets (AQU-533 §3).
// Mounted at /api/v2/changesets in src/index.ts.
//
//   GET  /:id/approval          load a changeset for the approval page
//   POST /:id/approve           mint a one-time confirmation (idempotent)
//   POST /:id/reject            discard a staged changeset
//
// All endpoints sit behind authMiddleware (browser session JWT) — this is the
// human-approval surface, distinct from the API-credential-authenticated
// agent surface in sync-worker/src/external/*. AuthZ (v1, spec-decided): only
// the human who owns the credential that staged the changeset may approve or
// reject it (changesets.created_by_user_id === the session user's id).
//
// Error envelope mirrors sync-worker's external error contract
// (sync-worker/src/external/errors.ts): `{ error: { code, message, details? } }`
// with the same stable codes so an agent/UI can branch consistently across
// both workers.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"

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
  summary: unknown
  digest: string
  created_at: unknown
  expires_at: unknown
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
              c.credential_id, c.autonomy_mode, c.status, c.summary, c.digest,
              c.created_at, c.expires_at
         FROM changesets c
         LEFT JOIN projects p ON p.id = c.project_id
        WHERE c.id = ?`,
    )
    .bind(id)
    .first<ChangesetRow>()
  return row ?? null
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
  if (cs.created_by_user_id !== String(user.id)) {
    const { body, status } = errorJson(
      "permission_denied",
      "only the human who owns this changeset's credential may view its approval",
    )
    return c.json(body, status)
  }

  return c.json({
    changesetId: cs.id,
    projectId: cs.project_id,
    projectName: cs.project_name,
    status: cs.status,
    autonomyMode: cs.autonomy_mode,
    summary: parseJson<unknown>(cs.summary),
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
    if (cs.created_by_user_id !== String(user.id)) {
      const { body, status } = errorJson(
        "permission_denied",
        "only the human who owns this changeset's credential may approve it",
      )
      return c.json(body, status)
    }
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
  if (cs.created_by_user_id !== String(user.id)) {
    const { body, status } = errorJson(
      "permission_denied",
      "only the human who owns this changeset's credential may reject it",
    )
    return c.json(body, status)
  }
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

export default changesetApprovals
