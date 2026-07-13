// Aquilla sync worker.
//
// AD-1 keeps realtime state transient and project-scoped: ProjectSync owns
// focus locks, presence, and live event fan-out. Durable content state is
// Postgres (Neon) events/projections plus R2 media blobs; this worker no
// longer exposes a CRDT document runtime. Postgres is reached through the
// D1-compatible shim (db/shim/postgres.ts) over Hyperdrive — the D1→Neon
// cutover is complete and D1 is no longer a datastore here.

import { handleAdminRequest } from "./admin"
import { handleAudioRequest } from "./audio"
import { handleVoiceConvertRequest, handleVoiceReferenceRequest } from "./voice-convert"
import { handleTtsRequest } from "./tts"
import { handleDiarizationRequest } from "./diarization"
import { notifyProjectDo } from "./archive-broadcast"
import { handleCorsPreflight, withCors } from "./cors"
import { handleProjectArchiveRequest } from "./project-archive"
import { handleMemberRemovedRequest, notifyProjectDoMemberRemoved } from "./member-removed"
import { handleProjectSettingsChangedRequest } from "./project-settings-notify"
import { handleCellsAuditReadRequest } from "./events/cells-audit-read-route"
import { handleCellHistoryReadRequest } from "./events/cell-history-read-route"
import { handleMemberActivityReadRequest } from "./events/member-activity-read-route"
import { handleCellsReadRequest } from "./events/cells-read-route"
import { handleCellConfidenceRequest } from "./events/cell-confidence-route"
import { handleHealthRollupRequest } from "./events/health-rollup-route"
import { handleCellAudioReadRequest } from "./events/cell-audio-read-route"
import { handleEventsReadRequest } from "./events/read-route"
import { handleEventsWriteRequest } from "./events/route"
import { handleExternalChangesetsRequest } from "./external/changesets-route"
import { handleFilesReadRequest } from "./events/files-read-route"
import { handleProgressReadRequest } from "./events/progress-read-route"
import { handleBulkImportRequest } from "./events/import-route"
import { handleBulkMorphImportRequest } from "./events/import-morph-route"
import { handleMigrateIngestRequest } from "./events/migrate-ingest-route"
import { handleMigrateSettingsRequest } from "./events/migrate-settings-route"
import { handleMigrateProjectRequest } from "./events/migrate-project-route"
import { handleMigrateEventIdsRequest } from "./events/migrate-event-ids-route"
import { handleMigrateFinalizeRequest } from "./events/migrate-finalize-route"
import { handleMigrateAudioRequest } from "./events/migrate-audio-route"
import { handleMigrateAudioCopyRequest } from "./events/migrate-audio-copy-route"
import { handleMigrateOrgTeamMapsRequest } from "./events/migrate-org-team-maps-route"
import { handleMigrateGroupsRequest } from "./events/migrate-groups-route"
import { handleMigrateUsersReadRequest } from "./events/migrate-users-read-route"
import { handleExportSourceRequest } from "./events/export-route"
import { handleExportBundleRequest } from "./events/export-bundle-route"
import { handleRebuildProjectionRequest } from "./events/rebuild"
import { handleRebuildFtsRequest } from "./events/rebuild-fts"
import { handleSearchReadRequest, handleSearchPassagesRequest } from "./events/search-route"
import { handleStaleSourceRequest } from "./events/stale-source-route"
import { handleLinkSyncRequest } from "./events/link-sync-route"
import { handleLinkCursorBatchesRequest } from "./events/link-cursor-batches-route"
import { handleValidatorsReadRequest } from "./events/validators-read-route"
import { handleBranchingSearchRequest } from "./events/branching-search-route"
import { handleBranchingSearchPassagesRequest } from "./events/branching-search-passages-route"
import { handleCommentsReadRequest } from "./events/comments-read-route"
import { handleCellBacktranslationsReadRequest } from "./events/cell-backtranslations-read-route"
import { handleExternalReadRequest } from "./external/read-routes"
import { handleExternalMcpRequest } from "./external/mcp-route"
export { ProjectSync } from "./project-do"
// Inert legacy DO class — kept exported so deploys don't trip the
// "script does not export class 'FileSync'" guard. See file-sync-legacy.ts.
export { FileSync } from "./file-sync-legacy"
import { makePostgres } from "../../db/shim/postgres"

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Cloudflare namespace augmentation requires this syntax
  namespace Cloudflare {
    interface Env {
      /**
       * Per-project Durable Object holding live coordination state — focus
       * locks + presence + the relay for `event.applied` broadcasts.
       */
      ProjectSync?: DurableObjectNamespace
      /** R2 media/original-import blob bucket. Not used for Y.Doc state. */
      SNAPSHOTS: R2Bucket
      /** Read-only binding to GitLab's LFS object-storage bucket
       *  (codex-attachments-v1-1), used only by /migrate/audio-copy to copy
       *  legacy audio bytes bucket→bucket without leaving Cloudflare. Absent in
       *  envs that don't run the audio import. */
      LFS_SRC?: R2Bucket
      /** The events + projections store. NOT a D1 binding — it is the
       *  D1-compatible Postgres (Neon) shim, injected per-request at the top of
       *  `fetch` from HYPERDRIVE. Typed as `AquillaDb` only because the ~80
       *  routes speak the D1 `.prepare()/.batch()` API against the shim. */
      AQUILLA_PG?: AquillaDb
      /** Postgres (Neon) via Hyperdrive — the sole datastore. Required: when
       *  absent the worker fails fast (see `fetch`) rather than silently
       *  serving an empty local D1. */
      HYPERDRIVE?: Hyperdrive
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
      /** OmniVoice TTS Modal endpoint (infra/modal/omnivoice.py). */
      OMNIVOICE_URL?: string
      /** Shared secret for the OmniVoice endpoint (matches its OMNIVOICE_TOKEN). */
      OMNIVOICE_TOKEN?: string
      /** Per-user daily TTS audio-seconds cap (default 36000 = 10 h while sizing). */
      TTS_USER_DAILY_SECONDS_LIMIT?: string
      /** "true" → enforce TTS cap with 429; anything else → log-only. */
      TTS_BUDGET_ENFORCE?: string
      /** Optional KV namespace for AD-13 branching-search result cache.
       *  When absent, the route runs the algorithm fresh on every request.
       *  Provision: `wrangler kv:namespace create BRANCHING_SEARCH_KV`. */
      BRANCHING_SEARCH_KV?: KVNamespace
      /** Modal-hosted pyannote diarization endpoint (infra/modal/diarization.py). */
      DIARIZATION_MODAL_URL?: string
      /** Shared secret authenticating both directions worker↔Modal diarization. */
      DIARIZATION_SHARED_SECRET?: string
      /** Public base URL of THIS worker (incl. /sync prefix in prod) so Modal
       *  can reach the diarization audio + callback routes. */
      DIARIZATION_PUBLIC_BASE?: string
      /** Cloudflare Email Service `send_email` binding for outbound transactional
       *  email (comment notifications). Declared only in deployed env blocks
       *  (wrangler.toml); absent locally/e2e where notifications no-op. */
      EMAIL?: import("./notification-email").EmailService
      /** Optional — From address for transactional email. Defaults to noreply@support.aquilla.app. */
      EMAIL_FROM?: string
      /** Optional — Base URL for deep links in notification emails (e.g. https://aquilla.app). */
      BASE_URL?: string
      /**
       * Flat per-call TTS cost estimate in cents (amortised GPU cold-start etc.).
       * Default: 2 (2¢ per synthesis call). Spec § Config.
       */
      TTS_COST_CENTS_PER_CALL?: string
      /**
       * Additional per-audio-second cost in cents. Default: 0.
       * Tune once actual GPU billing is available.
       */
      TTS_COST_PER_AUDIO_SEC_CENTS?: string
    }
  }
}

type Env = Cloudflare.Env

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

/** Path prefix when the worker is mounted under the API subdomain via
 *  Workers Routes (`api.aquilla.app/sync/*`). Stripped before any routing so
 *  the handlers keep their bare paths (`/events`, `/parties/...`,
 *  `/api/v1/...`). Mirrors identity's `/identity` strip. Conditional, so
 *  direct `workers.dev` / local `wrangler dev` calls (no prefix) keep
 *  working unchanged. Pre-migration this was `/api/sync` under the apex. */
const APEX_PREFIX = "/sync"

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Must run before CORS / route matching — those test bare paths.
    request = stripApexPrefix(request)

    // Postgres (Neon) is the only datastore. Serve AQUILLA_PG via the
    // D1-compatible Postgres shim (per-request connection, closed after the
    // response). HYPERDRIVE is required — without it we fail fast instead of
    // falling through to an empty local D1 (the D1→Neon cutover removed D1 as a
    // store; a missing binding is a deploy/config error, not a fallback).
    if (!env.HYPERDRIVE) {
      return new Response(
        "HYPERDRIVE not bound — Postgres is required (D1 has been removed as a datastore)",
        { status: 500 },
      )
    }
    const pgShim: { close(): Promise<void> } = makePostgres(env.HYPERDRIVE.connectionString)
    env = { ...env, AQUILLA_PG: pgShim as unknown as AquillaDb }
    try {
    const preflight = handleCorsPreflight(request)
    if (preflight) return preflight

    const projectArchiveResponse = await handleProjectArchiveRequest(request, env, notifyProjectDo)
    if (projectArchiveResponse) return projectArchiveResponse
    // AQU-346: eject a removed member's live WS sessions + denylist their
    // still-valid tokens on the per-project DO.
    const memberRemovedResponse = await handleMemberRemovedRequest(
      request,
      env,
      notifyProjectDoMemberRemoved,
    )
    if (memberRemovedResponse) return memberRemovedResponse
    const projectSettingsChangedResponse = await handleProjectSettingsChangedRequest(request, env)
    if (projectSettingsChangedResponse) return projectSettingsChangedResponse
    const rebuildResponse = await handleRebuildProjectionRequest(request, env)
    if (rebuildResponse) return rebuildResponse
    const rebuildFtsResponse = await handleRebuildFtsRequest(request, env)
    if (rebuildFtsResponse) return rebuildFtsResponse
    const adminResponse = await handleAdminRequest(request, env)
    if (adminResponse) return adminResponse
    const audioResponse = await handleAudioRequest(request, env)
    if (audioResponse) return audioResponse
    const voiceConvertResponse = await handleVoiceConvertRequest(request, env)
    if (voiceConvertResponse) return withCors(voiceConvertResponse, request)
    const voiceReferenceResponse = await handleVoiceReferenceRequest(request, env)
    if (voiceReferenceResponse) return withCors(voiceReferenceResponse, request)
    const ttsResponse = await handleTtsRequest(request, env)
    if (ttsResponse) return withCors(ttsResponse, request)
    const diarizationResponse = await handleDiarizationRequest(request, env)
    if (diarizationResponse) return withCors(diarizationResponse, request)
    const eventsReadResponse = await handleEventsReadRequest(request, env)
    if (eventsReadResponse) return withCors(eventsReadResponse, request)
    const validatorsReadResponse = await handleValidatorsReadRequest(request, env)
    if (validatorsReadResponse) return withCors(validatorsReadResponse, request)
    const cellsAuditReadResponse = await handleCellsAuditReadRequest(request, env)
    if (cellsAuditReadResponse) return withCors(cellsAuditReadResponse, request)
    const filesReadResponse = await handleFilesReadRequest(request, env)
    if (filesReadResponse) return withCors(filesReadResponse, request)
    const progressReadResponse = await handleProgressReadRequest(request, env)
    if (progressReadResponse) return withCors(progressReadResponse, request)
    const cellsReadResponse = await handleCellsReadRequest(request, env)
    if (cellsReadResponse) return withCors(cellsReadResponse, request)
    const cellConfidenceResponse = await handleCellConfidenceRequest(request, env)
    if (cellConfidenceResponse) return withCors(cellConfidenceResponse, request)
    const healthRollupResponse = await handleHealthRollupRequest(request, env)
    if (healthRollupResponse) return withCors(healthRollupResponse, request)
    const cellAudioReadResponse = await handleCellAudioReadRequest(request, env)
    if (cellAudioReadResponse) return withCors(cellAudioReadResponse, request)
    const cellHistoryResponse = await handleCellHistoryReadRequest(request, env)
    if (cellHistoryResponse) return withCors(cellHistoryResponse, request)
    const memberActivityResponse = await handleMemberActivityReadRequest(request, env)
    if (memberActivityResponse) return withCors(memberActivityResponse, request)
    const staleSourceResponse = await handleStaleSourceRequest(request, env)
    if (staleSourceResponse) return withCors(staleSourceResponse, request)
    const linkSyncResponse = await handleLinkSyncRequest(request, env)
    if (linkSyncResponse) return withCors(linkSyncResponse, request)
    const linkCursorBatchesResponse = await handleLinkCursorBatchesRequest(request, env)
    if (linkCursorBatchesResponse) return withCors(linkCursorBatchesResponse, request)
    const commentsReadResponse = await handleCommentsReadRequest(request, env)
    if (commentsReadResponse) return withCors(commentsReadResponse, request)
    const btReadResponse = await handleCellBacktranslationsReadRequest(request, env)
    if (btReadResponse) return withCors(btReadResponse, request)
    const externalReadResponse = await handleExternalReadRequest(request, env)
    if (externalReadResponse) return withCors(externalReadResponse, request)
    // /search/passages must be checked BEFORE /search — PATH_RE for /search is
    // anchored with $ so it won't match /search/passages, but ordering here
    // makes the intent explicit and guards against future regex changes.
    const searchPassagesResponse = await handleSearchPassagesRequest(request, env)
    if (searchPassagesResponse) return withCors(searchPassagesResponse, request)
    const searchResponse = await handleSearchReadRequest(request, env)
    if (searchResponse) return withCors(searchResponse, request)
    const branchingPassagesResponse = await handleBranchingSearchPassagesRequest(request, env)
    if (branchingPassagesResponse) return withCors(branchingPassagesResponse, request)
    const branchingSearchResponse = await handleBranchingSearchRequest(request, env)
    if (branchingSearchResponse) return withCors(branchingSearchResponse, request)
    const bulkImportResponse = await handleBulkImportRequest(request, env, ctx)
    if (bulkImportResponse) return bulkImportResponse
    const bulkMorphImportResponse = await handleBulkMorphImportRequest(request, env)
    if (bulkMorphImportResponse) return bulkMorphImportResponse
    const migrateIngestResponse = await handleMigrateIngestRequest(request, env)
    if (migrateIngestResponse) return migrateIngestResponse
    const migrateSettingsResponse = await handleMigrateSettingsRequest(request, env)
    if (migrateSettingsResponse) return migrateSettingsResponse
    const migrateProjectResponse = await handleMigrateProjectRequest(request, env)
    if (migrateProjectResponse) return migrateProjectResponse
    const migrateEventIdsResponse = await handleMigrateEventIdsRequest(request, env)
    if (migrateEventIdsResponse) return migrateEventIdsResponse
    const migrateFinalizeResponse = await handleMigrateFinalizeRequest(request, env)
    if (migrateFinalizeResponse) return migrateFinalizeResponse
    const migrateAudioResponse = await handleMigrateAudioRequest(request, env)
    if (migrateAudioResponse) return migrateAudioResponse
    const migrateAudioCopyResponse = await handleMigrateAudioCopyRequest(request, env)
    if (migrateAudioCopyResponse) return migrateAudioCopyResponse
    const migrateOrgTeamMapsResponse = await handleMigrateOrgTeamMapsRequest(request, env)
    if (migrateOrgTeamMapsResponse) return migrateOrgTeamMapsResponse
    const migrateGroupsResponse = await handleMigrateGroupsRequest(request, env)
    if (migrateGroupsResponse) return migrateGroupsResponse
    const migrateUsersReadResponse = await handleMigrateUsersReadRequest(request, env)
    if (migrateUsersReadResponse) return migrateUsersReadResponse
    const exportSourceResponse = await handleExportSourceRequest(request, env)
    if (exportSourceResponse) return exportSourceResponse
    const exportBundleResponse = await handleExportBundleRequest(request, env)
    if (exportBundleResponse) return exportBundleResponse
    const eventsWriteResponse = await handleEventsWriteRequest(request, env, ctx)
    if (eventsWriteResponse) return withCors(eventsWriteResponse, request)

    // AQU-533: Agent API changeset engine (external command layer).
    const externalChangesetsResponse = await handleExternalChangesetsRequest(request, env, ctx)
    if (externalChangesetsResponse) return withCors(externalChangesetsResponse, request)

    // AQU-533: Agent API remote MCP server (tools-only, streamable HTTP).
    const externalMcpResponse = await handleExternalMcpRequest(request, env, ctx)
    if (externalMcpResponse) return withCors(externalMcpResponse, request)

    const projectSyncResponse = routeProjectSync(request, env)
    if (projectSyncResponse) return projectSyncResponse

    return new Response("not found", { status: 404 })
    } finally {
      ctx.waitUntil(pgShim.close())
    }
  },
}
