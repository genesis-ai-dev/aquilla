// External API credentials (personal access tokens) for the Agent API
// (AQU-533 §2 "Trust model"). Mounted at /api/v2/credentials.
//
//   POST   /            mint a credential — returns the plaintext token ONCE
//   GET    /            list the caller's credentials (never hashes)
//   DELETE /:id         revoke a credential (owner or platform admin; idempotent)
//
// Scope + autonomy rules (§2):
//   - A caller may only scope a credential to an org/project where they hold
//     >= CONTRIBUTOR (resolved live via the existing role resolvers).
//   - Mode 'act' additionally requires >= MAINTAINER on the scoped project or
//     org. An 'act' credential must therefore carry a scope.
//   - The credential is a ceiling only: every API call re-resolves the user's
//     live role, so a credential never exceeds the user.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import type { AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { isPlatformAdmin } from "../middleware/platform-admin"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { countRecentEvents, recordAuthEvent, userIdentifier, CREDENTIAL_MINT_MAX_PER_USER } from "../utils/rate-limit"

// Re-exported so the command layer imports credential validation from one place.
export { validateApiCredential } from "../../../db/shared/api-credentials"

const credentials = new Hono<AuthHonoEnv>()

const createSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(["ask", "act"]),
  orgId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  // ISO-8601 timestamp; validated as a real date below.
  expiresAt: z.string().datetime().optional(),
})

interface CredentialRow {
  id: string
  name: string
  mode: "ask" | "act"
  org_id: string | null
  project_id: string | null
  token_prefix: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
}

/** Public JSON shape — never includes token_hash. */
function toDto(r: CredentialRow) {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    orgId: r.org_id,
    projectId: r.project_id,
    tokenPrefix: r.token_prefix,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }
}

credentials.post("/", authMiddleware, zValidator("json", createSchema), async (c) => {
  const user = c.get("user")
  const { name, mode, orgId, projectId, expiresAt } = c.req.valid("json")

  // [Pen test] API security & data exposure (2026-08-13): throttle minting
  // before doing any scope resolution — see rate-limit.ts for rationale.
  const mintIdent = userIdentifier(user.id)
  const recentMints = await countRecentEvents(c.env.AQUILLA_PG, "credential_mint", mintIdent, { onlyFailures: false })
  if (recentMints >= CREDENTIAL_MINT_MAX_PER_USER) {
    return c.json(
      { error: "rate_limited", message: "Too many credentials minted recently. Please try again later." },
      429,
    )
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "credential_mint", mintIdent, true)

  // Resolve the caller's live authority on the requested scope. A credential
  // can only be scoped where the user holds >= CONTRIBUTOR; 'act' needs
  // >= MAINTAINER. scopeLevel === null means "unscoped" (user-global).
  let scopeLevel: number | null = null
  if (projectId) {
    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role || role.level < ROLE.CONTRIBUTOR) {
      return c.json({ error: "scope_denied", message: "You need contributor access on this project to scope a credential to it." }, 403)
    }
    scopeLevel = role.level
  } else if (orgId) {
    const numericOrgId = Number(orgId)
    const level = Number.isInteger(numericOrgId)
      ? await getEffectiveOrgRole(c.env, numericOrgId, user)
      : null
    if (level == null || level < ROLE.CONTRIBUTOR) {
      return c.json({ error: "scope_denied", message: "You need contributor access on this org to scope a credential to it." }, 403)
    }
    scopeLevel = level
  }

  if (mode === "act") {
    if (scopeLevel == null) {
      return c.json({ error: "scope_denied", message: "Act-mode credentials must be scoped to an org or project." }, 403)
    }
    if (scopeLevel < ROLE.MAINTAINER) {
      return c.json({ error: "scope_denied", message: "Act-mode credentials require maintainer access on the scoped org or project." }, 403)
    }
  }

  let expiresAtValue: string | null = null
  if (expiresAt) {
    const ts = new Date(expiresAt).getTime()
    if (Number.isNaN(ts)) {
      return c.json({ error: "validation_failed", message: "expiresAt is not a valid timestamp." }, 400)
    }
    if (ts <= Date.now()) {
      return c.json({ error: "validation_failed", message: "expiresAt must be in the future." }, 400)
    }
    expiresAtValue = new Date(ts).toISOString()
  }

  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const id = crypto.randomUUID()

  const row = await c.env.AQUILLA_PG.prepare(
    `INSERT INTO api_credentials
        (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, name, mode, org_id, project_id, token_prefix,
               created_at, expires_at, last_used_at, revoked_at`,
  )
    .bind(
      id,
      String(user.id),
      name,
      tokenPrefix,
      tokenHash,
      mode,
      orgId ?? null,
      projectId ?? null,
      expiresAtValue,
    )
    .first<CredentialRow>()

  if (!row) return c.json({ error: "internal", message: "Failed to create credential." }, 500)

  // Plaintext token is returned exactly once — it is never stored or retrievable.
  return c.json({ token, credential: toDto(row) }, 201)
})

credentials.get("/", authMiddleware, async (c) => {
  const user = c.get("user")
  const result = await c.env.AQUILLA_PG.prepare(
    `SELECT id, name, mode, org_id, project_id, token_prefix,
            created_at, expires_at, last_used_at, revoked_at
       FROM api_credentials
      WHERE user_id = ?
      ORDER BY created_at DESC`,
  )
    .bind(String(user.id))
    .all<CredentialRow>()

  return c.json({ credentials: (result.results ?? []).map(toDto) })
})

credentials.delete("/:id", authMiddleware, async (c) => {
  const user = c.get("user")
  const id = c.req.param("id")

  const row = await c.env.AQUILLA_PG.prepare(
    "SELECT user_id FROM api_credentials WHERE id = ?",
  )
    .bind(id)
    .first<{ user_id: string }>()

  if (!row) return c.json({ error: "not_found", message: "Credential not found." }, 404)

  // Only the owner or a platform admin may revoke.
  if (row.user_id !== String(user.id) && !isPlatformAdmin(c)) {
    return c.json({ error: "permission_denied", message: "You may not revoke this credential." }, 403)
  }

  // Idempotent: COALESCE keeps the original revoked_at on a repeat revoke.
  await c.env.AQUILLA_PG.prepare(
    "UPDATE api_credentials SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ?",
  )
    .bind(id)
    .run()

  return c.json({ ok: true })
})

export default credentials
