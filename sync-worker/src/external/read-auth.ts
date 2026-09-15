// Shared auth / scope / throttle gate for the external read tier.
//
// Extracted from read-routes.ts (AQU-1232, then AQU-1236) so every read route
// module — the project-scoped reads, the org-scoped reads in
// org-read-routes.ts, and search-reads.ts — runs through the SAME credential
// validation, project scope check, live-role resolution and per-credential
// throttle. Duplicating any of it is how a scoping hole gets introduced: one
// adapter gains a check the other never got.
//
// Every project-scoped external read:
//   1. validates the `aqk_` credential (hashed lookup, revocation/expiry),
//   2. checks it is scoped to this project (credential.projectId null-or-match)
//      and this project's org (credential.orgId null-or-match projects.org_id),
//   3. resolves the calling user's LIVE role on the project (>= VIEWER (100)
//      required) — never trusts a role baked into the credential itself.
//
// Nothing here is new behavior beyond that — it is read-routes.ts's gate, moved.

import { sign } from "hono/jwt"
import type { SyncTokenClaims } from "../auth"
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

/** Credential-only gate (no project in play yet) — used by /me, /projects and
 *  /orgs, and as the first step of the project-scoped gate below. 401 messages
 *  teach the auth scheme: a cold-start agent's first failed call should tell it
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

  return scopeCredentialToProject(env, credentialed.credential, projectId)
}

/**
 * The project half of the gate, for callers that already authenticated: assert
 * the credential's scope covers this project and resolve the caller's LIVE role
 * on it. Split out for the cross-project reads (AQU-1236), which authenticate
 * ONCE and then run this per project in the list — re-validating the token N
 * times would add a DB read per project for no extra safety.
 */
export async function scopeCredentialToProject(
  env: ExternalReadsEnv,
  credential: ApiCredentialContext,
  projectId: string,
): Promise<{ ok: true; ctx: AuthedContext } | { ok: false; response: Response }> {
  if (!env.AQUILLA_PG) {
    return { ok: false, response: new Response("AQUILLA_PG binding not configured", { status: 500 }) }
  }

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

/** Mint a short-lived (30s) internal sync-token JWT so we can call the
 *  existing internal route handlers in-process without re-deriving their
 *  auth/ETag/anchor-chain logic. `fileId` is only meaningful to the doc-scoped
 *  verifier the DO uses; project-scoped read routes ignore it. */
export async function mintInternalToken(
  env: ExternalReadsEnv,
  ctx: AuthedContext,
  projectId: string,
  fileId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: Number(ctx.credential.userId),
    projectId,
    fileId,
    role: ctx.role,
    aud: "sync",
    iat: now,
    exp: now + 30,
  }
  return sign(claims as unknown as Record<string, unknown>, env.SYNC_SECRET_KEY as string, "HS256")
}

// ---------------------------------------------------------------------------
// Throttles
// ---------------------------------------------------------------------------

// Search is the cheapest external call to spam (no write, no changeset) and
// the most abuse-prone (FTS over the whole project on every request), so it's
// the first external route throttled. Scoped per credential, not per IP — PAT
// callers are already authenticated and IP-scoping a bot-run agent buys
// nothing. Wide enough that a legitimate agent looping searches every few
// seconds never trips it; tight enough to blunt a leaked-PAT query flood.
export const SEARCH_MAX_PER_CREDENTIAL = 300

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

/**
 * Shared throttle for search. `cost` is how many search units this call
 * consumes — a cross-project search over N projects runs N FTS queries, so it
 * charges N units rather than 1 (AQU-1236): fanning out must not be a way to
 * buy N times the search budget for the price of one request.
 */
export async function checkSearchRateLimit(
  db: AquillaDb,
  credentialId: string,
  cost = 1,
): Promise<Response | null> {
  const identifier = `credential:${credentialId}`
  const recent = await countRecentRateLimitEvents(db, "external_search", identifier)
  if (recent >= SEARCH_MAX_PER_CREDENTIAL) {
    return externalError("rate_limited", "search rate limit exceeded, slow down", 429)
  }
  for (let i = 0; i < cost; i++) {
    await recordRateLimitEvent(db, "external_search", identifier)
  }
  return null
}
