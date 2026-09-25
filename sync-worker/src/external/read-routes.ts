// External read surface (AGENT-API §4 read tier — AQU-533 W1-C).
//
//   GET /api/v1/external/me                                — identity bootstrap
//   GET /api/v1/external/orgs                              — list accessible orgs      (org-read-routes.ts)
//   GET /api/v1/external/orgs/:orgId/projects              — that org's projects       (org-read-routes.ts)
//   GET /api/v1/external/projects?orgId=                   — list accessible projects
//   GET /api/v1/external/projects/:projectId                — one project + settings/version
//   GET /api/v1/external/search?q=&projectIds=a,b          — cross-project search      (search-reads.ts)
//   GET /api/v1/external/projects/:projectId/search?q=&side=&limit=&cursor=            (search-reads.ts)
//   GET /api/v1/external/projects/:projectId/similar?cellId=|text=&limit=&cursor=
//   GET /api/v1/external/projects/:projectId/files?limit=&cursor=
//   GET /api/v1/external/projects/:projectId/files/:fileId/cells?since=&limit=&cursor=
//   GET /api/v1/external/projects/:projectId/cells/:cellId/history?limit=&cursor=
//   GET /api/v1/external/projects/:projectId/settings          — settings + live version
//   GET /api/v1/external/projects/:projectId/cells/:cellId/prompt-preview?targetLang=&fileId=
//
// /me, /orgs and /projects are the REST cold-start set (mirrors of the MCP
// get_identity_and_scope / list_orgs / list_projects tools): they need only a
// valid credential, no projectId — without them a REST caller had no way to
// discover a project id at all.
//
// Auth: `Authorization: Bearer aqk_...` — a credential minted via the
// api_credentials table (db/shared/api-credentials.ts), NOT a sync-token JWT.
// The shared gate lives in read-auth.ts; every request:
//   1. validates the credential (hashed lookup, revocation/expiry),
//   2. checks it is scoped to this project (credential.projectId null-or-match)
//      and this project's org (credential.orgId null-or-match projects.org_id),
//   3. resolves the calling user's LIVE role on the project (>= VIEWER (100)
//      required) — never trusts a role baked into the credential itself.
//
// These are thin wrappers: no query/search/read logic is reimplemented here.
//   - /search (both forms) lives in search-reads.ts and delegates to
//     scoped-search.ts's queryScopedSearch, the single structural choke-point
//     for project-scoped FTS (same as search-route.ts).
//   - /orgs and /orgs/:orgId/projects live in org-read-routes.ts over the
//     shared orgs-list.ts / projects-list.ts scope queries.
//   - /similar lives in similar-route.ts (this file is at its size budget) and
//     delegates to the same choke-point's querySimilarSourceCells. It is
//     mounted from THIS router so the MCP tier, which delegates reads through
//     handleExternalReadRequest alone, picks it up like every other read.
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

import { externalError } from "./errors"
import { listProjectsForCredential } from "./projects-list"
import { assertOrgInCredentialScope, handleExternalOrgReadRequest } from "./org-read-routes"
import { handleExternalCrossProjectSearch, handleExternalSearch } from "./search-reads"
import { handleFilesReadRequest } from "../events/files-read-route"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { loadProjectSettings } from "../../../db/shared/projects"
import { filterSettingsBlobForMember } from "../../../db/shared/lane-visibility"
import { paginate, parsePageParams } from "./pagination"
import { recordAgentRead, resolveAuthorshipPolicy, scrubAuthorField } from "./pii"
import { handleExternalSimilarRequest } from "./similar-route"
import { handlePromptPreview } from "./prompt-preview"
import { loadProjectDetail } from "./project-detail"
import {
  authenticateAndScope,
  authenticateCredential,
  checkReadRateLimit,
  mintInternalToken,
  type ExternalReadsEnv,
} from "./read-auth"

export type { ExternalReadsEnv } from "./read-auth"
export { mintInternalToken } from "./read-auth"

const ME_RE = /^\/api\/v1\/external\/me$/
const PROJECTS_RE = /^\/api\/v1\/external\/projects$/
const PROJECT_DETAIL_RE = /^\/api\/v1\/external\/projects\/([^/]+)$/
const CROSS_SEARCH_RE = /^\/api\/v1\/external\/search$/
const SEARCH_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/search$/
const FILE_CELLS_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/files\/([^/]+)\/cells$/
const FILES_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/files$/
const CELL_HISTORY_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/cells\/([^/]+)\/history$/
const SETTINGS_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/settings$/
const PROMPT_PREVIEW_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/cells\/([^/]+)\/prompt-preview$/

// ---------------------------------------------------------------------------
// GET /api/v1/external/me — cold-start step 1: prove the token works, learn
// your identity, autonomy mode, scope, and what to call next.
// ---------------------------------------------------------------------------

async function handleExternalMe(request: Request, env: ExternalReadsEnv): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential.credentialId)
  if (limited) return limited
  const cred = authed.credential
  return Response.json({
    // AQU-1180: identity is opt-in. By default /me answers "which token am I
    // and what may I do", never "who is the human behind it" — an agent needs
    // the former to work and the latter never leaves this worker unless an
    // OWNER minted the credential with `pii` on. The scope ids (org/project)
    // stay: they are the credential's own reach, not a person.
    ...(cred.pii === true ? { userId: cred.userId, username: cred.username } : {}),
    mode: cred.mode,
    orgId: cred.orgId,
    projectId: cred.projectId,
    credentialId: cred.credentialId,
    hints: {
      mode:
        cred.mode === "ask"
          ? "ask mode: you can prepare changesets but a commit needs a human approval at the approvalUrl first (commit returns 428 confirmation_required until then)."
          : "act mode: commit applies a prepared changeset immediately.",
      next: "GET /api/v1/external/projects to find a projectId, then GET /api/v1/external/projects/:projectId/files. Managing a whole workspace? GET /api/v1/external/orgs, then /api/v1/external/orgs/:orgId/projects, and search several at once with GET /api/v1/external/search?q=&projectIds=a,b. GET /api/v1/external for the full API map.",
    },
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects — cold-start step 2: find a projectId.
// (REST mirror of the MCP list_projects tool; same shared query.)
// Optional ?orgId= narrows to one org (AQU-1236) — a filter on top of the
// credential's own scope, never a widening of it.
// ---------------------------------------------------------------------------

async function handleExternalProjects(request: Request, env: ExternalReadsEnv): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential.credentialId)
  if (limited) return limited

  const orgId = new URL(request.url).searchParams.get("orgId")
  const cred = authed.credential
  if (orgId !== null) {
    // Same gate as /orgs/:orgId/projects, deliberately shared: the two spellings
    // of "this org's projects" must answer an out-of-scope org identically
    // (scope_denied), or one of them would quietly return [] and make "not
    // yours" indistinguishable from "empty".
    const denied = await assertOrgInCredentialScope(env.AQUILLA_PG, cred, orgId)
    if (denied) return denied
  }

  const projects = await listProjectsForCredential(
    env.AQUILLA_PG,
    cred,
    orgId !== null ? { orgId } : {},
  )
  return Response.json({ data: projects, nextCursor: null })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId — cold-start step 3: read one
// project's detail INCLUDING its settings blob and live settings version.
//
// AQU-1222: this path used to fall through to the discovery 404, which left
// `PatchSettings.ifMatchVersion` (a hard prepare-time equality check) with no
// read to source it from. The response is the shared ExternalProjectDetail
// shape, identical to the MCP get_project tool's.
// ---------------------------------------------------------------------------

async function handleExternalProjectDetail(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  if (env.AQUILLA_PG) {
    const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.ctx.credential.credentialId)
    if (limited) return limited
  }

  // authenticateAndScope already 404s an unknown project id; a null here means
  // the project was deleted between the two reads.
  const detail = await loadProjectDetail(env.AQUILLA_PG as AquillaDb, projectId, authed.ctx.role, {
    flag: env.LANE_READ_WALL,
    userId: Number(authed.ctx.credential.userId),
  })
  if (!detail) return externalError("not_found", "project not found", 404)
  return Response.json(detail)
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
  if (env.AQUILLA_PG) {
    const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.ctx.credential.credentialId)
    if (limited) return limited
  }

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
  if (env.AQUILLA_PG) {
    const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.ctx.credential.credentialId)
    if (limited) return limited
  }

  // since/limit/cursor (and the cellIds fast-path param and the AQU-538
  // lane=<tag> target-lane filter) are supported natively by the internal
  // cells route — forward the querystring as-is.
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

  // AQU-1180: the internal cells route serves the SPA, where showing "last
  // edited by Anna" is the whole point — so the scrub happens HERE, at the
  // agent boundary, rather than in the shared serializer.
  const policy = await resolveAuthorshipPolicy(env.AQUILLA_PG, authed.ctx.credential, projectId)
  const cells = await scrubAuthorField(
    body.cells ?? [],
    "lastEditor",
    policy,
    env.SYNC_SECRET_KEY,
    projectId,
  )
  await recordAgentRead(env.AQUILLA_PG, {
    credentialId: authed.ctx.credential.credentialId,
    projectId,
    resource: "cells",
    resourceId: fileId,
    rowCount: cells.length,
  })

  return Response.json({
    data: cells,
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
  if (env.AQUILLA_PG) {
    const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.ctx.credential.credentialId)
    if (limited) return limited
  }

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

  const page = paginate(result.results.map(mapHistoryRow), offset, limit)

  // AQU-1180: history is the densest identity surface on the API — one author
  // per event, ordered in time. Scrub the page the caller actually receives
  // (the fetch over-reads by `offset` rows that are then sliced away).
  const policy = await resolveAuthorshipPolicy(env.AQUILLA_PG, authed.ctx.credential, projectId)
  const data = await scrubAuthorField(page.data, "author", policy, env.SYNC_SECRET_KEY, projectId)
  await recordAgentRead(env.AQUILLA_PG, {
    credentialId: authed.ctx.credential.credentialId,
    projectId,
    resource: "history",
    resourceId: cellId,
    rowCount: data.length,
  })
  return Response.json({ ...page, data })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/settings — the read that makes
// PatchSettings' `ifMatchVersion` usable at all (AQU-1176). Without it an
// agent had to guess the version and blind-overwrite settings it had never
// seen. Same auth/scope/throttle contract as every other project read.
// ---------------------------------------------------------------------------

async function handleExternalProjectSettings(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  if (env.AQUILLA_PG) {
    const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.ctx.credential.credentialId)
    if (limited) return limited
  }

  const current = await loadProjectSettings(env.AQUILLA_PG as AquillaDb, projectId)
  // `updatedBy` (the last writer's user id) is deliberately NOT echoed: this
  // is an agent-facing surface and the id identifies a human translator. The
  // blob + version are all `ifMatchVersion` needs. A project with no settings
  // row yet reads as `{}` at version 0 — patch against 0 to create it.
  // AQU-1421: the blob's lane registry is cut to this caller's grants when the
  // read wall is on. The version stays the live one so PatchSettings still matches.
  const settings = await filterSettingsBlobForMember(
    env.AQUILLA_PG as AquillaDb,
    env.LANE_READ_WALL,
    projectId,
    Number(authed.ctx.credential.userId),
    authed.ctx.role,
    current.settings,
  )
  return Response.json({
    projectId: current.projectId,
    settings,
    version: current.version,
    updatedAt: current.updatedAt,
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/cells/:cellId/prompt-preview
// — AQU-1230. The assembled copilot prompt for one cell, plus the labeled
// parts it was built from. Assembly lives in prompt-preview.ts; the perimeter
// (credential, scope, live role, rate limit) stays here with every other read.
// ---------------------------------------------------------------------------

async function handleExternalPromptPreview(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
  cellId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  if (env.AQUILLA_PG) {
    const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.ctx.credential.credentialId)
    if (limited) return limited
  }
  return handlePromptPreview(request, { AQUILLA_PG: env.AQUILLA_PG }, projectId, cellId)
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
  if (CROSS_SEARCH_RE.test(url.pathname)) return handleExternalCrossProjectSearch(request, env)

  // /orgs and /orgs/:orgId/projects (AQU-1236).
  const orgResponse = await handleExternalOrgReadRequest(request, env)
  if (orgResponse) return orgResponse

  let match = url.pathname.match(SEARCH_RE)
  if (match) return handleExternalSearch(request, env, decodeURIComponent(match[1]))

  // AQU-1232: lives in its own module (this file is already at its size
  // budget) but is mounted here so the MCP tier's runRead delegation — which
  // only knows handleExternalReadRequest — reaches it like any other read.
  const similar = await handleExternalSimilarRequest(request, env)
  if (similar) return similar

  // Must be checked before FILES_RE — FILES_RE is anchored with $ so it
  // won't accidentally match /files/:fileId/cells, but ordering here makes
  // the intent explicit (mirrors search-route.ts's /search vs /search/passages).
  match = url.pathname.match(FILE_CELLS_RE)
  if (match) {
    return handleExternalFileCells(request, env, decodeURIComponent(match[1]), decodeURIComponent(match[2]))
  }

  match = url.pathname.match(FILES_RE)
  if (match) return handleExternalFiles(request, env, decodeURIComponent(match[1]))

  // Must be checked before CELL_HISTORY_RE only for readability — both are
  // anchored, so they cannot collide.
  match = url.pathname.match(PROMPT_PREVIEW_RE)
  if (match) {
    return handleExternalPromptPreview(
      request,
      env,
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    )
  }

  match = url.pathname.match(CELL_HISTORY_RE)
  if (match) {
    return handleExternalCellHistory(request, env, decodeURIComponent(match[1]), decodeURIComponent(match[2]))
  }

  match = url.pathname.match(SETTINGS_RE)
  if (match) return handleExternalProjectSettings(request, env, decodeURIComponent(match[1]))

  // Last of the /projects/* family: its regex is the least specific, so every
  // deeper project route above must get first refusal.
  match = url.pathname.match(PROJECT_DETAIL_RE)
  if (match) return handleExternalProjectDetail(request, env, decodeURIComponent(match[1]))

  return null
}
