// Aquilla sync worker.
//
// AD-1 keeps realtime state transient and project-scoped: ProjectSync owns
// focus locks, presence, and live event fan-out. Durable content state is
// D1 events/projections plus R2 media blobs; this worker no longer exposes
// a CRDT document runtime.

import { DurableObject } from "cloudflare:workers"
import { handleAdminRequest } from "./admin"
import { handleAudioRequest } from "./audio"
import { handleVoiceConvertRequest, handleVoiceReferenceRequest } from "./voice-convert"
import { notifyProjectDo } from "./archive-broadcast"
import { handleCorsPreflight, withCors } from "./cors"
import { handleProjectArchiveRequest } from "./project-archive"
import { handleCellsAuditReadRequest } from "./events/cells-audit-read-route"
import { handleCellHistoryReadRequest } from "./events/cell-history-read-route"
import { handleCellsReadRequest } from "./events/cells-read-route"
import { handleCellAudioReadRequest } from "./events/cell-audio-read-route"
import { handleEventsReadRequest } from "./events/read-route"
import { handleEventsWriteRequest } from "./events/route"
import { handleFilesReadRequest } from "./events/files-read-route"
import { handleBulkImportRequest } from "./events/import-route"
import { handleRebuildProjectionRequest } from "./events/rebuild"
import { handleSearchReadRequest } from "./events/search-route"
import { handleStaleSourceRequest } from "./events/stale-source-route"
import { handleValidatorsReadRequest } from "./events/validators-read-route"
import { handleBranchingSearchRequest } from "./events/branching-search-route"
import { handleBranchingSearchPassagesRequest } from "./events/branching-search-passages-route"
export { ProjectSync } from "./project-do"

declare global {
  namespace Cloudflare {
    interface Env {
      /** Legacy binding kept only so existing deployments/migrations remain valid. */
      FileSync?: DurableObjectNamespace
      /**
       * Per-project Durable Object holding live coordination state — focus
       * locks + presence + the relay for `event.applied` broadcasts.
       */
      ProjectSync?: DurableObjectNamespace
      /** R2 media/original-import blob bucket. Not used for Y.Doc state. */
      SNAPSHOTS: R2Bucket
      /** Identity-owned D1 schema containing events and projections. */
      AQUILLA_DB?: D1Database
      /** Shared HMAC key with identity that mints /sync-token JWTs. */
      SYNC_SECRET_KEY?: string
      /**
       * Dev escape hatch. "true" disables JWT verification for ProjectSync
       * WS connections. Set to "false" (or omit) in production.
       */
      ALLOW_UNAUTHENTICATED?: string
      /** Optional R2 key prefix for PR/staging isolation. */
      R2_KEY_PREFIX?: string
      /** Seed-VC voice-clone Modal endpoint (infra/modal/seed_vc.py). */
      SEED_VC_URL?: string
      /** Shared secret for the Seed-VC endpoint (matches its SEED_VC_TOKEN). */
      SEED_VC_TOKEN?: string
    }
  }
}

type Env = Cloudflare.Env

/**
 * Compatibility Durable Object for the old per-file CRDT room binding.
 * No dispatcher routes traffic here anymore; direct callers receive a clear
 * 410 rather than reviving CRDT document state.
 */
export class FileSync extends DurableObject<Env> {
  fetch(): Response {
    return new Response("FileSync CRDT runtime removed; use ProjectSync and /events", {
      status: 410,
    })
  }
}

function routeProjectSync(request: Request, env: Env): Response | Promise<Response> | null {
  const url = new URL(request.url)
  const projectSyncMatch = url.pathname.match(/^\/parties\/project-sync\/([^/]+)\/?$/)
  if (!projectSyncMatch) return null
  if (!env.ProjectSync) {
    return new Response("ProjectSync DO not bound", { status: 503 })
  }

  const projectId = decodeURIComponent(projectSyncMatch[1])
  const id = env.ProjectSync.idFromName(projectId)
  const stub = env.ProjectSync.get(id)
  const inner = new URL(request.url)
  inner.pathname = "/connect"
  inner.searchParams.set("project", projectId)
  return stub.fetch(new Request(inner.toString(), request))
}

/** Path prefix when the worker is mounted under the apex via Workers Routes
 *  (`aquilla.app/api/sync/*`). Stripped before any routing so the handlers
 *  keep their bare paths (`/events`, `/parties/...`, `/api/v1/...`). Mirrors
 *  identity's `/api/identity` strip. Conditional, so direct `workers.dev` /
 *  local `wrangler dev` calls (no prefix) keep working unchanged. */
const APEX_PREFIX = "/api/sync"

function stripApexPrefix(request: Request): Request {
  const url = new URL(request.url)
  if (url.pathname !== APEX_PREFIX && !url.pathname.startsWith(`${APEX_PREFIX}/`)) {
    return request
  }
  url.pathname = url.pathname.slice(APEX_PREFIX.length) || "/"
  // Preserve method, headers (incl. `Upgrade: websocket`), and body so WS
  // upgrades and POST bodies survive the rewrite.
  return new Request(url.toString(), request)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Must run before CORS / route matching — those test bare paths.
    request = stripApexPrefix(request)

    const preflight = handleCorsPreflight(request)
    if (preflight) return preflight

    const projectArchiveResponse = await handleProjectArchiveRequest(request, env, notifyProjectDo)
    if (projectArchiveResponse) return projectArchiveResponse
    const rebuildResponse = await handleRebuildProjectionRequest(request, env)
    if (rebuildResponse) return rebuildResponse
    const adminResponse = await handleAdminRequest(request, env)
    if (adminResponse) return adminResponse
    const audioResponse = await handleAudioRequest(request, env)
    if (audioResponse) return audioResponse
    const voiceConvertResponse = await handleVoiceConvertRequest(request, env)
    if (voiceConvertResponse) return withCors(voiceConvertResponse, request)
    const voiceReferenceResponse = await handleVoiceReferenceRequest(request, env)
    if (voiceReferenceResponse) return withCors(voiceReferenceResponse, request)
    const eventsReadResponse = await handleEventsReadRequest(request, env)
    if (eventsReadResponse) return withCors(eventsReadResponse, request)
    const validatorsReadResponse = await handleValidatorsReadRequest(request, env)
    if (validatorsReadResponse) return withCors(validatorsReadResponse, request)
    const cellsAuditReadResponse = await handleCellsAuditReadRequest(request, env)
    if (cellsAuditReadResponse) return withCors(cellsAuditReadResponse, request)
    const filesReadResponse = await handleFilesReadRequest(request, env)
    if (filesReadResponse) return withCors(filesReadResponse, request)
    const cellsReadResponse = await handleCellsReadRequest(request, env)
    if (cellsReadResponse) return withCors(cellsReadResponse, request)
    const cellAudioReadResponse = await handleCellAudioReadRequest(request, env)
    if (cellAudioReadResponse) return withCors(cellAudioReadResponse, request)
    const cellHistoryResponse = await handleCellHistoryReadRequest(request, env)
    if (cellHistoryResponse) return withCors(cellHistoryResponse, request)
    const staleSourceResponse = await handleStaleSourceRequest(request, env)
    if (staleSourceResponse) return withCors(staleSourceResponse, request)
    const searchResponse = await handleSearchReadRequest(request, env)
    if (searchResponse) return withCors(searchResponse, request)
    const branchingPassagesResponse = await handleBranchingSearchPassagesRequest(request, env)
    if (branchingPassagesResponse) return withCors(branchingPassagesResponse, request)
    const branchingSearchResponse = await handleBranchingSearchRequest(request, env)
    if (branchingSearchResponse) return withCors(branchingSearchResponse, request)
    const bulkImportResponse = await handleBulkImportRequest(request, env)
    if (bulkImportResponse) return bulkImportResponse
    const eventsWriteResponse = await handleEventsWriteRequest(request, env)
    if (eventsWriteResponse) return withCors(eventsWriteResponse, request)

    const projectSyncResponse = routeProjectSync(request, env)
    if (projectSyncResponse) return projectSyncResponse

    return new Response("not found", { status: 404 })
  },
}
