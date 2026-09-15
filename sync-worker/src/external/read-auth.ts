// Shared credential/scope gate for the external READ tier.
//
// Extracted from read-routes.ts (AQU-1232) so a second read route module can
// use the exact same gate without importing read-routes.ts back into itself.
// The gate itself is unchanged — every project-scoped external read:
//   1. validates the `aqk_` credential (hashed lookup, revocation/expiry),
//   2. checks it is scoped to this project (credential.projectId null-or-match)
//      and this project's org (credential.orgId null-or-match projects.org_id),
//   3. resolves the calling user's LIVE role on the project (>= VIEWER (100)
//      required) — never trusts a role baked into the credential itself.

import { ROLE } from "../events/role-policy"
import { externalError } from "./errors"
import { AUTH_HINT } from "./discovery-route"
import { validateApiCredential, type ApiCredentialContext } from "../../../db/shared/api-credentials"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../db/shared/rate-limit"

export interface ExternalReadsEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

/** Credential-only gate (no project in play yet) — used by /me and /projects,
 *  and as the first step of the project-scoped gate below. 401 messages teach
 *  the auth scheme: a cold-start agent's first failed call should tell it
 *  exactly how to succeed, not just that it failed. */
export async function authenticateCredential(
  request: Request,
  env: ExternalReadsEnv,
): Promise<{ ok: true; credential: ApiCredentialContext } | { ok: false; response: Response }> {
  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return {
      ok: false,
      response: externalError("permission_denied", `missing Authorization header — ${AUTH_HINT}`, 401),
    }
  }

  const credential = await validateApiCredential(env.AQUILLA_PG as AquillaDb, token)
  if (!credential) {
    // Collapses invalid/revoked/expired into one generic message — the code
    // (permission_denied) is what callers branch on, not the message text.
    return {
      ok: false,
      response: externalError(
        "permission_denied",
        `invalid, revoked, or expired API credential — ${AUTH_HINT}`,
        401,
      ),
    }
  }
  return { ok: true, credential }
}

export interface AuthedContext {
  credential: ApiCredentialContext
  /** Live-resolved role level (>= ROLE.VIEWER), NOT the credential's own
   *  (nonexistent) role field — the credential only carries autonomy/scope. */
  role: number
}

export async function authenticateAndScope(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<{ ok: true; ctx: AuthedContext } | { ok: false; response: Response }> {
  if (!env.SYNC_SECRET_KEY) {
    return { ok: false, response: new Response("SYNC_SECRET_KEY not configured", { status: 500 }) }
  }
  if (!env.AQUILLA_PG) {
    return { ok: false, response: new Response("AQUILLA_PG binding not configured", { status: 500 }) }
  }

  const credentialed = await authenticateCredential(request, env)
  if (!credentialed.ok) return credentialed
  const credential = credentialed.credential

  const projectRow = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ org_id: number | string | bigint | null }>()
  if (!projectRow) {
    return { ok: false, response: externalError("not_found", "project not found", 404) }
  }
  const projectOrgId = projectRow.org_id == null ? null : String(projectRow.org_id)

  if (credential.projectId !== null && credential.projectId !== projectId) {
    return {
      ok: false,
      response: externalError("scope_denied", "credential is not scoped to this project", 403),
    }
  }
  if (credential.orgId !== null && credential.orgId !== projectOrgId) {
    return {
      ok: false,
      response: externalError("scope_denied", "credential is not scoped to this org", 403),
    }
  }

  const resolved = await resolveProjectRoleShared(env.AQUILLA_PG, { id: credential.userId }, projectId)
  const role = resolved?.level ?? null
  if (role === null || role < ROLE.VIEWER) {
    return { ok: false, response: externalError("permission_denied", "no project membership", 403) }
  }

  return { ok: true, ctx: { credential, role } }
}

// [Pen test] API security & data exposure (2026-08-27): /me, /projects,
// /files, /files/:fileId/cells, and /cells/:cellId/history had NO throttle —
// discovery-route.ts's own error-code docs admitted rate limiting was
// "enforced on /search, changeset prepare, changeset commit, and artifact
// upload" only, i.e. every other external route was explicitly excluded. A
// leaked or malicious PAT could scrape a project's entire file/cell/history
// graph without limit. Same cap and per-credential scoping as search — these
// are comparably cheap, paginated reads.
export const READ_MAX_PER_CREDENTIAL = 300

/** Shared throttle for the plain read routes. Returns a 429 Response if the
 *  credential is over budget (and records nothing further), else records this
 *  call and returns null. */
export async function checkReadRateLimit(db: AquillaDb, credentialId: string): Promise<Response | null> {
  const identifier = `credential:${credentialId}`
  const recent = await countRecentRateLimitEvents(db, "external_read", identifier)
  if (recent >= READ_MAX_PER_CREDENTIAL) {
    return externalError("rate_limited", "read rate limit exceeded, slow down", 429)
  }
  await recordRateLimitEvent(db, "external_read", identifier)
  return null
}
