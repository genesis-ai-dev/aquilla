// Codex sync worker: one Durable Object per file, backed by y-partyserver.
// Client connects via y-partyserver/provider at wss://.../parties/file-sync/{docId}.
// docId is "{projectId}--{fileId}" (double-dash separator — both halves are
// allowed to contain single dashes, e.g. UUIDs). Canonical Y.Doc state lives
// in R2 as snapshot + tail objects.
//
// R2 layout:
//   projects/{projectId}/files/{fileId}/snapshot.bin    — last compacted state
//   projects/{projectId}/files/{fileId}/tail/{seq}.bin  — updates since snapshot
//
// Tokens are required in prod (set SYNC_SECRET_KEY, leave ALLOW_UNAUTHENTICATED
// unset). onBeforeConnect verifies JWTs and stashes the role claim; the DO's
// isReadOnly reads it to gate writes. See auth.ts for the verifier.
// onSave projects the Y.Doc into codex-db (files + cells) so dashboards can
// read counts + text without touching the Y.Doc. See projection.ts.

import { YServer } from "y-partyserver"
import type { Connection, ConnectionContext } from "partyserver"
import * as Y from "yjs"
import { routePartykitRequest } from "partyserver"
import { verifyTokenForDoc, shouldBeReadOnly } from "./auth"
export { ProjectSync } from "./project-do"
import { projectDoc, writeProjection } from "./projection"
import { handleAdminRequest } from "./admin"
import { handleAudioRequest } from "./audio"
import {
  handleProjectArchiveRequest,
  readArchiveMarker,
  type ArchiveMarker,
} from "./project-archive"
import { handleRebuildProjectionRequest } from "./events/rebuild"
import { hydrateYDocFromEvents, applyCellCommitToDoc } from "./events/hydrate"
import { handleEventsWriteRequest } from "./events/route"
import { handleEventsReadRequest } from "./events/read-route"
import { handleValidatorsReadRequest } from "./events/validators-read-route"
import { handleCellsAuditReadRequest } from "./events/cells-audit-read-route"
import { handleFilesReadRequest } from "./events/files-read-route"
import { handleCellsReadRequest } from "./events/cells-read-route"
import { handleCellHistoryReadRequest } from "./events/cell-history-read-route"
import { handleSearchReadRequest } from "./events/search-route"
import { handleStaleSourceRequest } from "./events/stale-source-route"
import { handleBranchingSearchRequest } from "./events/branching-search-route"
import { handleCorsPreflight, withCors } from "./cors"
import { notifyFileDo } from "./archive-broadcast"
import { parseRealtimeMessage } from "./events/realtime"
import { encodeNextTail } from "./incremental"

const ROLE_HEADER = "X-Codex-Role"

declare global {
  namespace Cloudflare {
    interface Env {
      FileSync: DurableObjectNamespace
      /**
       * Per-project Durable Object holding live coordination state — focus
       * locks + presence + the relay for `event.applied` broadcasts.
       * Phase 2c. Optional binding so existing deploys without the migration
       * keep working; the new WS routes 503 when absent.
       */
      ProjectSync?: DurableObjectNamespace
      SNAPSHOTS: R2Bucket
      /** codex-db (identity-owned schema). Optional so the spike + dev
       *  setups without a D1 binding keep working — onSave skips projection
       *  when absent. In prod, the binding is wired in wrangler.toml and
       *  AQUILLA_DB is always present. */
      AQUILLA_DB?: D1Database
      /** Shared HMAC key with identity that mints /sync-token JWTs.
       *  Distinct from Frontier's main SECRET_KEY so a sync-worker compromise
       *  cannot forge Frontier access tokens. */
      SYNC_SECRET_KEY?: string
      /**
       * Dev escape hatch. "true" disables JWT verification for WS connections,
       * used until the client is wired to fetch /sync-token. Set to "false"
       * (or omit) in production.
       */
      ALLOW_UNAUTHENTICATED?: string
      /**
       * Optional R2 key prefix. Empty / unset on prod and the shared staging
       * worker. Per-PR worker variants set this to `pr-<N>` so they can
       * share `aquilla-snapshots-staging` with the dev/preview sandbox without
       * stepping on each other's snapshots.
       */
      R2_KEY_PREFIX?: string
    }
  }
}
type Env = Cloudflare.Env

// Fallback prefix when a room name doesn't include a project scope.
// Keeps the older spike tests that pass bare fileIds working.
const SPIKE_PROJECT_PREFIX = "spike"
const DOC_ID_SEPARATOR = "--"

/** Resolves the optional R2_KEY_PREFIX env var into a normalized prefix
 *  (empty string or trailing-slash form). Centralized so every key
 *  constructor agrees on the rules. */
export function r2KeyPrefix(env: Pick<Env, "R2_KEY_PREFIX">): string {
  const p = env.R2_KEY_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  return p ? `${p}/` : ""
}

function snapshotKey(env: Pick<Env, "R2_KEY_PREFIX">, projectId: string, fileId: string): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/snapshot.bin`
}

function tailPrefix(env: Pick<Env, "R2_KEY_PREFIX">, projectId: string, fileId: string): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/tail/`
}

/** R2 prefix that lists *every* object for a file (snapshot + all tails + checkpoints). */
function fileObjectPrefix(env: Pick<Env, "R2_KEY_PREFIX">, projectId: string, fileId: string): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/`
}

function parseDocId(name: string): { projectId: string; fileId: string } {
  const idx = name.indexOf(DOC_ID_SEPARATOR)
  if (idx < 0) return { projectId: SPIKE_PROJECT_PREFIX, fileId: name }
  return {
    projectId: name.slice(0, idx),
    fileId: name.slice(idx + DOC_ID_SEPARATOR.length),
  }
}

// Grace period after the last client disconnects before we compact tails into
// a snapshot. Keeps churn low when a user is just reloading — the DO stays
// warm and the alarm is rescheduled on reconnect instead of firing.
const COMPACTION_GRACE_MS = 60 * 1000

// Tail count that triggers background compaction during an active session.
// At the default 2 s onSave debounce that's ~100 s of continuous editing —
// bounded onLoad replay cost even for hours-long sessions without evictions.
const MID_SESSION_COMPACT_AT_TAILS = 50

// Cap on per-cell `edits` Y.Array length. Each entry is a nested Y.Map with
// authors/editMap/validatedBy sub-types — Yjs allocates significant CRDT
// metadata per entry, so an unbounded array is a major cause of doc bloat
// and DO OOM on long-lived projects. 100 entries comfortably covers active
// review while keeping memory bounded. Mirror of EDITS_CAP_PER_CELL in
// src/lib/codex-editor/edits/yjs-helpers.ts — keep in sync.
const EDITS_CAP_PER_CELL = 100

// Cap on per-cell `history` Y.Array length. Each entry is a plain object with
// the full `value` text duplicated, so for long cells the array bytes grow
// quickly. 100 entries gives the UI's history drawer plenty of context while
// bounding the doc. Mirror of HISTORY_CAP_PER_CELL on the client.
const HISTORY_CAP_PER_CELL = 100

/**
 * Walk every cell in the doc and trim both append-only Y.Arrays that grow
 * unboundedly during normal use:
 *  - `edits`   — Y.Array<Y.Map>, validation log; trim oldest entries.
 *  - `history` — Y.Array<plain CellHistoryEntry>, audit log; trim oldest.
 *
 * History entries duplicate the full cell value, so trimming is the cheap
 * way to win back doc size without losing recent context.
 *
 * Returns counts so the admin endpoint can report what was changed. The
 * caller is responsible for wrapping in doc.transact() — we don't transact
 * here so the caller can compose with other mutations.
 */
function pruneCellHistory(doc: Y.Doc): {
  cellsTouched: number
  editsTrimmedFromTotal: number
  editsTrimmedToTotal: number
  historyTrimmedFromTotal: number
  historyTrimmedToTotal: number
} {
  const cellsMap = doc.getMap("cells")
  let cellsTouched = 0
  let editsTrimmedFromTotal = 0
  let editsTrimmedToTotal = 0
  let historyTrimmedFromTotal = 0
  let historyTrimmedToTotal = 0

  cellsMap.forEach((value) => {
    const cell = value as Y.Map<unknown>
    let touched = false

    const edits = cell.get("edits") as Y.Array<unknown> | undefined
    if (edits && edits.length > EDITS_CAP_PER_CELL) {
      editsTrimmedFromTotal += edits.length
      edits.delete(0, edits.length - EDITS_CAP_PER_CELL)
      editsTrimmedToTotal += edits.length
      touched = true
    }

    const history = cell.get("history") as Y.Array<unknown> | undefined
    if (history && history.length > HISTORY_CAP_PER_CELL) {
      historyTrimmedFromTotal += history.length
      history.delete(0, history.length - HISTORY_CAP_PER_CELL)
      historyTrimmedToTotal += history.length
      touched = true
    }

    if (touched) cellsTouched++
  })

  return {
    cellsTouched,
    editsTrimmedFromTotal,
    editsTrimmedToTotal,
    historyTrimmedFromTotal,
    historyTrimmedToTotal,
  }
}

/**
 * Merge existing snapshot + all tail blobs into a new snapshot, then delete
 * the tails. Idempotent: running it twice in a row is a no-op (second call
 * sees no tails). Reads directly from R2 so it works both when the DO's
 * Y.Doc is warm in memory and when the alarm wakes a cold DO.
 */
async function compactToSnapshot(
  env: Pick<Env, "R2_KEY_PREFIX"> & { SNAPSHOTS: R2Bucket },
  projectId: string,
  fileId: string
): Promise<number> {
  const bucket = env.SNAPSHOTS
  const prefix = tailPrefix(env, projectId, fileId)
  const snapKey = snapshotKey(env, projectId, fileId)

  const [existingSnap, tails] = await Promise.all([
    bucket.get(snapKey),
    bucket.list({ prefix }),
  ])

  if (tails.objects.length === 0) return 0

  const updates: Uint8Array[] = []
  if (existingSnap) {
    updates.push(new Uint8Array(await existingSnap.arrayBuffer()))
  }
  const tailKeys = tails.objects.map((o) => o.key).sort()
  for (const key of tailKeys) {
    const obj = await bucket.get(key)
    if (!obj) continue
    updates.push(new Uint8Array(await obj.arrayBuffer()))
  }

  // Y.mergeUpdates returns the combined update bytes that, when applied to a
  // fresh Y.Doc, reproduce the state of applying every input update in order.
  const merged = Y.mergeUpdates(updates)
  await bucket.put(snapKey, merged)

  // Delete the consumed tails AFTER the snapshot is written. If the deletes
  // fail we're still consistent: onLoad replays snapshot + surviving tails
  // (applying an update already in the snapshot is a no-op in Yjs).
  await bucket.delete(tailKeys)

  return tailKeys.length
}

export class FileSync extends YServer {
  static options = { hibernate: true }
  static callbackOptions = {
    debounceWait: 2000,
    debounceMaxWait: 10000,
    timeout: 5000,
  }

  // Tail count since the last compaction. Tracked in-memory to avoid a list()
  // round-trip on every onSave. Seeded from R2 on cold-start (onLoad) and
  // reset after background compaction. Counter is never authoritative — it's
  // a heuristic for "should we kick off compaction now?"; R2 is truth.
  private tailCount = 0
  private compactionInFlight = false
  // State vector at the last successful tail write. Seeded from the doc in
  // onLoad so the first post-cold-start save doesn't redundantly emit the
  // full state. Each onSave writes only updates since this vector, keeping
  // tail sizes (and peak DO memory during compaction) bounded.
  private lastFlushedSV: Uint8Array | null = null

  async onLoad(): Promise<Y.Doc | void> {
    const { projectId, fileId } = parseDocId(this.name)
    const snap = await this.env.SNAPSHOTS.get(snapshotKey(this.env, projectId, fileId))
    if (snap) {
      const buf = new Uint8Array(await snap.arrayBuffer())
      Y.applyUpdate(this.document, buf)
    }

    // Replay tail updates since the last compaction.
    const list = await this.env.SNAPSHOTS.list({ prefix: tailPrefix(this.env, projectId, fileId) })
    const keys = list.objects.map((o) => o.key).sort()
    for (const key of keys) {
      const obj = await this.env.SNAPSHOTS.get(key)
      if (!obj) continue
      const buf = new Uint8Array(await obj.arrayBuffer())
      Y.applyUpdate(this.document, buf)
    }
    this.tailCount = keys.length

    // Cold-start hydration: when neither the snapshot nor any tail produced
    // cells (e.g. projects imported as source.cell.create / target.cell.commit
    // events straight to D1, never opened before), replay events to seed the
    // doc.
    // Gated on `cells` being empty so a partially-loaded doc from R2 is left
    // alone — Yjs would not merge replayed commits cleanly with existing CRDT
    // state, and the live event stream is the path for additive updates after
    // first open. Skipped silently when AQUILLA_DB isn't bound (spike/dev).
    const cellsMap = this.document.getMap("cells")
    if (cellsMap.size === 0 && this.env.AQUILLA_DB) {
      try {
        const result = await hydrateYDocFromEvents(
          this.env.AQUILLA_DB,
          projectId,
          fileId,
          this.document,
        )
        if (result.cellCount > 0) {
          // Persist the hydrated state to R2 immediately so subsequent loads
          // skip the event replay. Writes the full state under the snapshot
          // key (not a tail) — matches what compactToSnapshot would produce.
          const update = Y.encodeStateAsUpdate(this.document)
          await this.env.SNAPSHOTS.put(snapshotKey(this.env, projectId, fileId), update)
          console.log(
            `[FileSync.onLoad] hydrated ${this.name}: ${result.cellCount} cells from ${result.cellEventsApplied} events`,
          )
        }
      } catch (err) {
        // Hydration failure is non-fatal — the doc just loads empty and the
        // user can either retry the import or wait for live events. Log so
        // the operator can spot the failure in worker logs.
        console.warn(`[FileSync.onLoad] hydration failed for ${this.name}:`, err)
      }
    }

    // Seed the project-archive tombstone into `meta` so a client connecting to
    // a cold DO sees the banner without waiting for a broadcast. Writes only
    // when the marker's state differs from the doc's current meta to keep the
    // operation idempotent across reloads.
    const marker = await readArchiveMarker(this.env, projectId)
    this.applyArchiveMarker(marker)

    // After the archive marker is (possibly) merged in, snapshot the state
    // vector so the next onSave only emits updates made DURING this session,
    // not a redundant re-encoding of everything we just loaded.
    this.lastFlushedSV = Y.encodeStateVector(this.document)
  }

  /** Internal: writes the archive marker's state into the doc's `meta` map.
   *  Used both on cold load (onLoad) and live broadcasts (handleTombstoneRequest). */
  private applyArchiveMarker(marker: ArchiveMarker | null): void {
    const meta = this.document.getMap("meta")
    const currentAt = meta.get("projectDeletedAt")
    const currentBy = meta.get("projectDeletedBy")
    const nextAt = marker?.archivedAt ?? null
    const nextBy = marker?.deletedBy ?? null
    if (currentAt === nextAt && currentBy === nextBy) return
    this.document.transact(() => {
      if (nextAt) {
        meta.set("projectDeletedAt", nextAt)
        if (nextBy) meta.set("projectDeletedBy", nextBy)
        else meta.delete("projectDeletedBy")
      } else {
        meta.delete("projectDeletedAt")
        meta.delete("projectDeletedBy")
      }
    })
  }

  /**
   * Handles POST http://do.internal/__admin/tombstone from the sync-worker's
   * admin router. Authorized by SYNC_SECRET_KEY (the same secret gate used
   * for /admin/files/*). Writes `projectDeletedAt` / `projectDeletedBy`
   * into the Y.Doc's `meta` map; connected clients see the update instantly.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/__admin/tombstone") {
      const auth = request.headers.get("Authorization") ?? ""
      const expected = this.env.SYNC_SECRET_KEY
        ? `Bearer ${this.env.SYNC_SECRET_KEY}`
        : null
      if (!expected || auth !== expected) {
        return new Response("unauthorized", { status: 401 })
      }
      let marker: ArchiveMarker
      try {
        marker = (await request.json()) as ArchiveMarker
      } catch {
        return new Response("bad request", { status: 400 })
      }
      this.applyArchiveMarker(marker)
      return Response.json({ ok: true })
    }
    if (request.method === "POST" && url.pathname === "/__broadcast") {
      const auth = request.headers.get("Authorization") ?? ""
      const expected = this.env.SYNC_SECRET_KEY
        ? `Bearer ${this.env.SYNC_SECRET_KEY}`
        : null
      if (!expected || auth !== expected) {
        return new Response("unauthorized", { status: 401 })
      }
      const body = await request.text()
      // Validate as a RealtimeMessage before broadcasting (defense in depth).
      const parsed = parseRealtimeMessage(body)
      if (!parsed) {
        return new Response("invalid realtime message", { status: 400 })
      }
      // Broadcast to all WS connections in this room. partyserver's Server
      // has a `broadcast(message, exclude?)` method that sends to all peers.
      this.broadcast(body)
      return Response.json({ ok: true })
    }

    // Hot-update path: accepts a target.cell.commit / source.cell.commit
    // payload and applies it to the live Y.Doc in `new-only` mode so an
    // import seeding cells without a reload doesn't clobber an active
    // editor's draft. The events route does not currently call this — the
    // post-AD-2 reshape decoupled the live doc from the cells projection.
    if (request.method === "POST" && url.pathname === "/__apply-event") {
      const auth = request.headers.get("Authorization") ?? ""
      const expected = this.env.SYNC_SECRET_KEY
        ? `Bearer ${this.env.SYNC_SECRET_KEY}`
        : null
      if (!expected || auth !== expected) {
        return new Response("unauthorized", { status: 401 })
      }
      let body: { kind?: string; cellId?: string; payload?: unknown }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return new Response("bad request", { status: 400 })
      }
      // Accept either of the new commit kinds; older "cell.commit" callers
      // are explicitly unsupported (no users, no backcompat per AD-2 reshape).
      if (body.kind !== "target.cell.commit" && body.kind !== "source.cell.commit") {
        return Response.json({ ok: true, applied: false, reason: "non-commit kind" })
      }
      if (typeof body.cellId !== "string" || !body.payload || typeof body.payload !== "object") {
        return new Response("bad request", { status: 400 })
      }
      const result = applyCellCommitToDoc(this.document, {
        cellId: body.cellId,
        payload: body.payload as Parameters<typeof applyCellCommitToDoc>[1]['payload'],
        mode: "new-only",
      })
      return Response.json({ ok: true, ...result })
    }
    return new Response("not found", { status: 404 })
  }

  async onSave(): Promise<void> {
    const { projectId, fileId } = parseDocId(this.name)
    // Incremental diff against the last flushed state vector. Returns null
    // when nothing's changed since the previous save (e.g. onSave fired for
    // awareness-only traffic) — skip the R2 write in that case so we don't
    // litter R2 with empty tails.
    const encoded = encodeNextTail(this.document, this.lastFlushedSV)
    if (!encoded) return
    const seq = Date.now().toString().padStart(16, "0")
    const key = `${tailPrefix(this.env, projectId, fileId)}${seq}.bin`
    await this.env.SNAPSHOTS.put(key, encoded.update)
    this.lastFlushedSV = encoded.newSV
    this.tailCount += 1

    // Under AD-2 the cells projection is driven by the event log, not by
    // Y.Doc onSave. We still write a file-row rollup so the dashboard's
    // file listing stays current without a full event scan; failures are
    // non-fatal (the listing falls back to event-driven counts).
    if (this.env.AQUILLA_DB) {
      try {
        const result = projectDoc(projectId, fileId, this.document)
        await writeProjection(this.env.AQUILLA_DB, result, key)
      } catch (err) {
        console.warn(`projection failed for ${this.name}:`, err)
      }
    }

    // Long editing sessions without eviction let tails pile up — onLoad's
    // replay cost grows linearly. Compact in the background when we cross
    // the threshold so the save itself stays on the debounce budget.
    if (this.tailCount >= MID_SESSION_COMPACT_AT_TAILS && !this.compactionInFlight) {
      this.compactionInFlight = true
      this.ctx.waitUntil(this.compactInBackground(projectId, fileId))
    }
  }

  private async compactInBackground(projectId: string, fileId: string): Promise<void> {
    try {
      const removed = await compactToSnapshot(this.env, projectId, fileId)
      // Tails written during compaction bumped tailCount already; subtracting
      // the removed count gives the post-compact total (never goes negative
      // because onSave is the only thing that adds to tailCount).
      this.tailCount = Math.max(0, this.tailCount - removed)
    } catch (err) {
      console.warn(`mid-session compaction failed for ${this.name}:`, err)
    } finally {
      this.compactionInFlight = false
    }
  }

  // Stash the verified role on the connection so isReadOnly can gate writes.
  // onBeforeConnect (in the default fetch handler below) is where the token is
  // verified and the X-Codex-Role header is attached — trusted because we set
  // it ourselves from verified JWT claims after stripping any client-supplied
  // header of the same name.
  onConnect(conn: Connection, ctx: ConnectionContext): void {
    const roleHeader = ctx.request.headers.get(ROLE_HEADER)
    if (roleHeader) {
      const role = Number.parseInt(roleHeader, 10)
      if (Number.isFinite(role)) {
        conn.setState({ role })
      }
    }
    super.onConnect(conn, ctx)
  }

  isReadOnly(connection: Connection): boolean {
    const state = connection.state as { role?: number } | null
    return shouldBeReadOnly(state?.role)
  }
  // When the room empties, arm a compaction alarm. A reconnect within the
  // grace window reschedules (overwrites) the alarm so we don't compact
  // during a reload.
  async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await super.onClose(connection, code, reason, wasClean)
    const stillOpen = Array.from(this.getConnections()).length
    if (stillOpen === 0) {
      await this.ctx.storage.setAlarm(Date.now() + COMPACTION_GRACE_MS)
    }
  }

  // Alarm fires after the grace window with no reconnect. Compact, then let
  // the DO evict naturally (CF reclaims idle DOs).
  async onAlarm(): Promise<void> {
    const live = Array.from(this.getConnections()).length
    if (live > 0) return // someone rejoined — the next onClose will re-arm
    const { projectId, fileId } = parseDocId(this.name)
    try {
      const removed = await compactToSnapshot(this.env, projectId, fileId)
      this.tailCount = Math.max(0, this.tailCount - removed)
    } catch (err) {
      console.warn(`compaction failed for ${this.name}:`, err)
    }
  }
}

/**
 * POST /admin/files/:projectId/:fileId/compact-doc
 *
 * One-shot remediation for files whose Y.Doc has accumulated unbounded
 * per-cell history and exceeds DO memory limits at runtime. Loads the doc
 * from R2, drops the legacy `history` Y.Array, trims `edits` to the last N
 * entries per cell, and writes a fresh snapshot. Idempotent across retries.
 *
 * Auth: SYNC_SECRET_KEY. Returns the byte sizes before/after so the caller
 * can verify the prune actually shrank the doc.
 */
async function handleCompactDocRequest(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/admin\/files\/([^/]+)\/([^/]+)\/compact-doc$/)
  if (!match) return null
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })

  const auth = request.headers.get("Authorization") ?? ""
  const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
  if (!expected || auth !== expected) {
    return new Response("unauthorized", { status: 401 })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const snapKey = snapshotKey(env, projectId, fileId)
  const tailPref = tailPrefix(env, projectId, fileId)

  // Load existing snapshot + every tail into a fresh Y.Doc, then prune.
  // We don't go through the DO instance — running this against an active DO
  // could conflict with live edits. Operating on R2 directly + writing the
  // result back is safe because the DO will pick up the new snapshot on its
  // next cold start (and live clients that still have a session are operating
  // on a y-partyserver hibernated WS, which will close when the DO restarts).
  const snap = await env.SNAPSHOTS.get(snapKey)
  let snapBytesBefore = 0
  const doc = new Y.Doc()
  if (snap) {
    const buf = new Uint8Array(await snap.arrayBuffer())
    snapBytesBefore = buf.byteLength
    Y.applyUpdate(doc, buf)
  }

  const tailList = await env.SNAPSHOTS.list({ prefix: tailPref })
  const tailKeys = tailList.objects.map((o) => o.key).sort()
  let tailBytesBefore = 0
  for (const key of tailKeys) {
    const obj = await env.SNAPSHOTS.get(key)
    if (!obj) continue
    const buf = new Uint8Array(await obj.arrayBuffer())
    tailBytesBefore += buf.byteLength
    Y.applyUpdate(doc, buf)
  }

  let pruneStats: ReturnType<typeof pruneCellHistory> = {
    cellsTouched: 0,
    editsTrimmedFromTotal: 0,
    editsTrimmedToTotal: 0,
    historyTrimmedFromTotal: 0,
    historyTrimmedToTotal: 0,
  }
  doc.transact(() => {
    pruneStats = pruneCellHistory(doc)
  })

  const newSnap = Y.encodeStateAsUpdate(doc)
  await env.SNAPSHOTS.put(snapKey, newSnap)

  if (tailKeys.length > 0) {
    // R2 delete cap is 1000 keys per call.
    const CHUNK = 1000
    for (let i = 0; i < tailKeys.length; i += CHUNK) {
      await env.SNAPSHOTS.delete(tailKeys.slice(i, i + CHUNK))
    }
  }

  return Response.json({
    ok: true,
    projectId,
    fileId,
    before: { snapBytes: snapBytesBefore, tailCount: tailKeys.length, tailBytes: tailBytesBefore },
    after: { snapBytes: newSnap.byteLength, tailCount: 0, tailBytes: 0 },
    prune: pruneStats,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight for browser-facing CQRS routes — must run before any
    // handler that returns null on non-matching method, otherwise OPTIONS
    // falls through to partyserver and 404s.
    const preflight = handleCorsPreflight(request)
    if (preflight) return preflight

    // Admin paths are intercepted before partyserver so its routing
    // doesn't try to treat /admin/... as a party name.
    const projectArchiveResponse = await handleProjectArchiveRequest(request, env, notifyFileDo)
    if (projectArchiveResponse) return projectArchiveResponse
    const rebuildResponse = await handleRebuildProjectionRequest(request, env)
    if (rebuildResponse) return rebuildResponse
    const compactDocResponse = await handleCompactDocRequest(request, env)
    if (compactDocResponse) return compactDocResponse
    const adminResponse = await handleAdminRequest(request, env)
    if (adminResponse) return adminResponse
    const audioResponse = await handleAudioRequest(request, env)
    if (audioResponse) return audioResponse
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
    const cellHistoryResponse = await handleCellHistoryReadRequest(request, env)
    if (cellHistoryResponse) return withCors(cellHistoryResponse, request)
    const staleSourceResponse = await handleStaleSourceRequest(request, env)
    if (staleSourceResponse) return withCors(staleSourceResponse, request)
    const searchResponse = await handleSearchReadRequest(request, env)
    if (searchResponse) return withCors(searchResponse, request)
    const branchingSearchResponse = await handleBranchingSearchRequest(request, env)
    if (branchingSearchResponse) return withCors(branchingSearchResponse, request)
    const eventsWriteResponse = await handleEventsWriteRequest(request, env)
    if (eventsWriteResponse) return withCors(eventsWriteResponse, request)

    // Per-project DO WS upgrade (Phase 2c). Path is
    //   /parties/project-sync/<projectId>
    // and accepts `?token=<jwt>&user=<userId>`. The DO itself parses and
    // verifies the token (verifyTokenForProject) — we just route here.
    const projectSyncMatch = new URL(request.url).pathname.match(
      /^\/parties\/project-sync\/([^/]+)\/?$/,
    )
    if (projectSyncMatch) {
      if (!env.ProjectSync) {
        return new Response("ProjectSync DO not bound", { status: 503 })
      }
      const projectId = decodeURIComponent(projectSyncMatch[1])
      const id = env.ProjectSync.idFromName(projectId)
      const stub = env.ProjectSync.get(id)
      const inner = new URL(request.url)
      inner.pathname = "/connect"
      inner.searchParams.set("project", projectId)
      // `user` must be supplied by the client; the DO returns 400 if not.
      return stub.fetch(new Request(inner.toString(), request))
    }

    return (
      (await routePartykitRequest(request, env, {
        onBeforeConnect: async (req, lobby) => {
          // Always strip any client-supplied role header first; the only role
          // we trust is the one we attach ourselves from verified JWT claims.
          const safeHeaders = new Headers(req.headers)
          safeHeaders.delete(ROLE_HEADER)

          if (env.ALLOW_UNAUTHENTICATED === "true") {
            // Dev bypass: connection accepted with no role header, so the DO's
            // isReadOnly returns permissive (undefined role).
            return new Request(req, { headers: safeHeaders })
          }

          const url = new URL(req.url)
          const token = url.searchParams.get("token")
          const { projectId, fileId } = parseDocId(lobby.name)
          const result = await verifyTokenForDoc(
            token,
            { projectId, fileId },
            env.SYNC_SECRET_KEY
          )
          if (!result.ok) {
            return new Response(result.reason, { status: result.status })
          }
          safeHeaders.set(ROLE_HEADER, String(result.claims.role))
          return new Request(req, { headers: safeHeaders })
        },
      })) ?? new Response("not found", { status: 404 })
    )
  },
}
