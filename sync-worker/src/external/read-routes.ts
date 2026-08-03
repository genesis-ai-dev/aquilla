// External read surface (AGENT-API §4 read tier — AQU-533 W1-C).
//
//   GET /api/v1/external/me                                — identity bootstrap
//   GET /api/v1/external/projects                          — list accessible projects
//   GET /api/v1/external/projects/:projectId/search?q=&side=&limit=&cursor=
//   GET /api/v1/external/projects/:projectId/files?limit=&cursor=
//   GET /api/v1/external/projects/:projectId/files/:fileId/cells?since=&limit=&cursor=
//   GET /api/v1/external/projects/:projectId/cells/:cellId/history?limit=&cursor=
//
// /me and /projects are the REST cold-start pair (mirrors of the MCP
// get_identity_and_scope / list_projects tools): they need only a valid
// credential, no projectId — without them a REST caller had no way to
// discover a project id at all.
//
// Auth: `Authorization: Bearer aqk_...` — a credential minted via the
// api_credentials table (db/shared/api-credentials.ts), NOT a sync-token JWT.
// Every request:
//   1. validates the credential (hashed lookup, revocation/expiry),
//   2. checks it is scoped to this project (credential.projectId null-or-match)
//      and this project's org (credential.orgId null-or-match projects.org_id),
//   3. resolves the calling user's LIVE role on the project (>= VIEWER (100)
//      required) — never trusts a role baked into the credential itself.
//
// These are thin wrappers: no query/search/read logic is reimplemented here.
//   - /search delegates to scoped-search.ts's queryScopedSearch, the single
//     structural choke-point for project-scoped FTS (same as search-route.ts).
//   - /files and /files/:fileId/cells delegate to the EXISTING internal route
//     handlers (files-read-route.ts, cells-read-route.ts) via an in-process
//     call: we mint a short-lived internal sync-token JWT encoding the role we
//     already resolved and hand it to the handler exactly as an in-app caller
//     would. No network round-trip occurs and neither file is modified —
//     this sidesteps extracting their (non-exported, ETag/anchor-chain-walk-
//     entangled) internals, which extract-and-reexport would otherwise need.
//     SWARM-TODO(W1-C): if a later pass extracts real query helpers from
//     those routes, switch to calling them directly instead of minting a
//     token.
//   - /cells/:cellId/history is NOT scoped by fileId in the external contract
//     (unlike the internal route, which requires one) — cell_id is queried
//     directly against `events` per-project rather than per-(project,file),
//     which the internal handler cannot do. This duplicates the internal
//     route's small SELECT + JSON-payload mapping rather than its behavior.
//
// Response shape: always `{ data: [...], nextCursor: string | null }`
// (delta/resync flags from the underlying cells read are passed through
// alongside `data` when present). Errors: `{ error: { code, message } }`
// with codes from external/errors.ts.

import { sign } from "hono/jwt"
import type { SyncTokenClaims } from "../auth"
import { ROLE } from "../events/role-policy"
import { makeVerifiedProjectId, queryScopedSearch } from "../events/scoped-search"
import { handleFilesReadRequest } from "../events/files-read-route"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { externalError } from "./errors"
import { AUTH_HINT } from "./discovery-route"
import { listProjectsForCredential } from "./projects-list"
import { validateApiCredential, type ApiCredentialContext } from "../../../db/shared/api-credentials"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../db/shared/rate-limit"
import { paginate, parsePageParams } from "./pagination"

export interface ExternalReadsEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const ME_RE = /^\/api\/v1\/external\/me$/
const PROJECTS_RE = /^\/api\/v1\/external\/projects$/
const SEARCH_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/search$/
const FILE_CELLS_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/files\/([^/]+)\/cells$/
const FILES_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/files$/
const CELL_HISTORY_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/cells\/([^/]+)\/history$/

// ---------------------------------------------------------------------------
// Shared auth + scope gate
// ---------------------------------------------------------------------------

/** Credential-only gate (no project in play yet) — used by /me and /projects,
 *  and as the first step of the project-scoped gate below. 401 messages teach
 *  the auth scheme: a cold-start agent's first failed call should tell it
 *  exactly how to succeed, not just that it failed. */
async function authenticateCredential(
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

interface AuthedContext {
  credential: ApiCredentialContext
  /** Live-resolved role level (>= ROLE.VIEWER), NOT the credential's own
   *  (nonexistent) role field — the credential only carries autonomy/scope. */
  role: number
}

async function authenticateAndScope(
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

/** Mint a short-lived (30s) internal sync-token JWT so we can call the
 *  existing internal route handlers in-process without re-deriving their
 *  auth/ETag/anchor-chain logic. `fileId` is only meaningful to the doc-scoped
 *  verifier the DO uses; project-scoped read routes ignore it. */
async function mintInternalToken(
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
// GET /api/v1/external/me — cold-start step 1: prove the token works, learn
// your identity, autonomy mode, scope, and what to call next.
// ---------------------------------------------------------------------------

async function handleExternalMe(request: Request, env: ExternalReadsEnv): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const cred = authed.credential
  return Response.json({
    userId: cred.userId,
    username: cred.username,
    mode: cred.mode,
    orgId: cred.orgId,
    projectId: cred.projectId,
    credentialId: cred.credentialId,
    hints: {
      mode:
        cred.mode === "ask"
          ? "ask mode: you can prepare changesets but a commit needs a human approval at the approvalUrl first (commit returns 428 confirmation_required until then)."
          : "act mode: commit applies a prepared changeset immediately.",
      next: "GET /api/v1/external/projects to find a projectId, then GET /api/v1/external/projects/:projectId/files. GET /api/v1/external for the full API map.",
    },
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects — cold-start step 2: find a projectId.
// (REST mirror of the MCP list_projects tool; same shared query.)
// ---------------------------------------------------------------------------

async function handleExternalProjects(request: Request, env: ExternalReadsEnv): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const projects = await listProjectsForCredential(env.AQUILLA_PG, authed.credential)
  return Response.json({ data: projects, nextCursor: null })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/search
// ---------------------------------------------------------------------------

// Search is the cheapest external call to spam (no write, no changeset) and
// the most abuse-prone (FTS over the whole project on every request), so it's
// the first external route throttled. Scoped per credential, not per IP — PAT
// callers are already authenticated and IP-scoping a bot-run agent buys
// nothing. Wide enough that a legitimate agent looping searches every few
// seconds never trips it; tight enough to blunt a leaked-PAT query flood.
const SEARCH_MAX_PER_CREDENTIAL = 300

async function handleExternalSearch(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response

  if (env.AQUILLA_PG) {
    const identifier = `credential:${authed.ctx.credential.credentialId}`
    const recent = await countRecentRateLimitEvents(env.AQUILLA_PG, "external_search", identifier)
    if (recent >= SEARCH_MAX_PER_CREDENTIAL) {
      return externalError("rate_limited", "search rate limit exceeded, slow down", 429)
    }
    await recordRateLimitEvent(env.AQUILLA_PG, "external_search", identifier)
  }

  const url = new URL(request.url)
  const q = url.searchParams.get("q")
  if (q === null || q.trim() === "") {
    return externalError("validation_failed", "missing q", 400)
  }

  const qSide = url.searchParams.get("side")
  let side: "source" | "target" | undefined
  if (qSide !== null) {
    if (qSide !== "source" && qSide !== "target") {
      return externalError("validation_failed", "invalid side: must be source or target", 400)
    }
    side = qSide
  }

  const { limit, offset } = parsePageParams(url)

  // makeVerifiedProjectId only accepts a SyncTokenClaims-shaped object — we
  // already established project scope + role above, so this claims object is
  // legitimate (not a bypass): it just satisfies the branded-type gate that
  // queryScopedSearch requires, the same way search-route.ts's real JWT
  // claims do.
  const claims: SyncTokenClaims = {
    userId: Number(authed.ctx.credential.userId),
    projectId,
    fileId: "",
    role: authed.ctx.role,
    aud: "sync",
    iat: 0,
    exp: 0,
  }
  const verifiedProjectId = makeVerifiedProjectId(claims)

  // queryScopedSearch only supports limit (no offset) — over-fetch to
  // offset+limit (capped at its own MAX_LIMIT=500) and paginate in memory.
  // See pagination.ts's module doc for the offset-pagination caveat this implies.
  const fetchLimit = Math.min(500, offset + limit)

  try {
    const results = await queryScopedSearch(env.AQUILLA_PG as AquillaDb, verifiedProjectId, q, {
      side,
      limit: fetchLimit,
    })
    return Response.json(paginate(results, offset, limit))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("external search failed:", err)
    if (/syntax error|fts5/i.test(message)) {
      return externalError("validation_failed", "invalid search query", 400)
    }
    return externalError("validation_failed", "search failed", 400)
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/files
// ---------------------------------------------------------------------------

async function handleExternalFiles(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response

  const url = new URL(request.url)
  const { limit, offset } = parsePageParams(url)

  const token = await mintInternalToken(env, authed.ctx, projectId, "")
  const internalUrl = new URL(request.url)
  internalUrl.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/files`
  internalUrl.search = ""
  const internalRes = await handleFilesReadRequest(
    new Request(internalUrl.toString(), { headers: { Authorization: `Bearer ${token}` } }),
    env,
  )
  if (!internalRes) return externalError("not_found", "files route did not match", 404)
  if (!internalRes.ok) {
    return externalError("validation_failed", await internalRes.text(), internalRes.status)
  }

  const body = (await internalRes.json()) as { files: unknown[] }
  return Response.json(paginate(body.files, offset, limit))
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/files/:fileId/cells
// ---------------------------------------------------------------------------

async function handleExternalFileCells(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
  fileId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response

  // since/limit/cursor (and the cellIds fast-path param) are supported
  // natively by the internal cells route — forward the querystring as-is.
  const token = await mintInternalToken(env, authed.ctx, projectId, fileId)
  const internalUrl = new URL(request.url)
  internalUrl.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/cells`
  const internalRes = await handleCellsReadRequest(
    new Request(internalUrl.toString(), { headers: { Authorization: `Bearer ${token}` } }),
    env,
  )
  if (!internalRes) return externalError("not_found", "cells route did not match", 404)
  if (internalRes.status === 304) return new Response(null, { status: 304 })
  if (!internalRes.ok) {
    return externalError("validation_failed", await internalRes.text(), internalRes.status)
  }

  const body = (await internalRes.json()) as {
    cells?: unknown[]
    nextCursor?: string | null
    resync?: boolean
    delta?: boolean
    changedCellIds?: string[]
    maxServerSeq?: number | null
  }
  return Response.json({
    data: body.cells ?? [],
    nextCursor: body.nextCursor ?? null,
    ...(body.resync ? { resync: true } : {}),
    ...(body.delta ? { delta: true, changedCellIds: body.changedCellIds ?? [] } : {}),
    maxServerSeq: body.maxServerSeq ?? null,
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/cells/:cellId/history
// ---------------------------------------------------------------------------

interface EventRowRaw {
  id: string
  parent_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
  server_seq: number
}

interface CellHistoryEvent {
  id: string
  parentId: string | null
  kind: string
  author: string
  clientTs: number
  serverTs: number
  serverSeq: number
  payload: unknown
}

function mapHistoryRow(row: EventRowRaw): CellHistoryEvent {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    author: row.author,
    clientTs: row.client_ts,
    serverTs: row.server_ts,
    serverSeq: row.server_seq,
    payload: (() => {
      try {
        return JSON.parse(row.payload)
      } catch {
        return row.payload
      }
    })(),
  }
}

const HISTORY_MAX_LIMIT = 200

async function handleExternalCellHistory(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
  cellId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response

  const url = new URL(request.url)
  const { limit, offset } = parsePageParams(url, { defaultLimit: 50, maxLimit: HISTORY_MAX_LIMIT })

  // The external contract scopes history by (projectId, cellId) only — no
  // fileId, unlike the internal route (cell-history-read-route.ts), which
  // requires one. cell_id is unique enough within a project for this
  // purpose (both sides of a paired cell share cell_id but live in distinct
  // files; a caller wanting one side's chain specifically should use the
  // internal in-app route). Capped at HISTORY_MAX_LIMIT total rows fetched —
  // see pagination.ts's offset-pagination caveat.
  const fetchLimit = Math.min(HISTORY_MAX_LIMIT, offset + limit)
  const result = await (env.AQUILLA_PG as AquillaDb)
    .prepare(
      "SELECT id, parent_id, kind, author, payload, client_ts, server_ts, server_seq " +
        "FROM events WHERE project_id = ? AND cell_id = ? " +
        "ORDER BY server_seq DESC, id DESC " +
        "LIMIT ?",
    )
    .bind(projectId, cellId, fetchLimit)
    .all<EventRowRaw>()

  const events = result.results.map(mapHistoryRow)
  return Response.json(paginate(events, offset, limit))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleExternalReadRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  const url = new URL(request.url)

  if (ME_RE.test(url.pathname)) return handleExternalMe(request, env)
  if (PROJECTS_RE.test(url.pathname)) return handleExternalProjects(request, env)

  let match = url.pathname.match(SEARCH_RE)
  if (match) return handleExternalSearch(request, env, decodeURIComponent(match[1]))

  // Must be checked before FILES_RE — FILES_RE is anchored with $ so it
  // won't accidentally match /files/:fileId/cells, but ordering here makes
  // the intent explicit (mirrors search-route.ts's /search vs /search/passages).
  match = url.pathname.match(FILE_CELLS_RE)
  if (match) {
    return handleExternalFileCells(request, env, decodeURIComponent(match[1]), decodeURIComponent(match[2]))
  }

  match = url.pathname.match(FILES_RE)
  if (match) return handleExternalFiles(request, env, decodeURIComponent(match[1]))

  match = url.pathname.match(CELL_HISTORY_RE)
  if (match) {
    return handleExternalCellHistory(request, env, decodeURIComponent(match[1]), decodeURIComponent(match[2]))
  }

  return null
}
