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
import { projectDoc, writeProjection, diffProjection } from "./projection"
import { handleAdminRequest } from "./admin"

const ROLE_HEADER = "X-Codex-Role"

declare global {
  namespace Cloudflare {
    interface Env {
      FileSync: DurableObjectNamespace
      SNAPSHOTS: R2Bucket
      /** codex-db (frontier-server-owned schema). Optional so the spike + dev
       *  setups without a D1 binding keep working — onSave skips projection
       *  when absent. In prod, the binding is wired in wrangler.toml and
       *  CODEX_DB is always present. */
      CODEX_DB?: D1Database
      /** Shared HMAC key with frontier-server that mints /sync-token JWTs.
       *  Distinct from Frontier's main SECRET_KEY so a sync-worker compromise
       *  cannot forge Frontier access tokens. */
      SYNC_SECRET_KEY?: string
      /**
       * Dev escape hatch. "true" disables JWT verification for WS connections,
       * used until the client is wired to fetch /sync-token. Set to "false"
       * (or omit) in production.
       */
      ALLOW_UNAUTHENTICATED?: string
    }
  }
}
type Env = Cloudflare.Env

// Fallback prefix when a room name doesn't include a project scope.
// Keeps the older spike tests that pass bare fileIds working.
const SPIKE_PROJECT_PREFIX = "spike"
const DOC_ID_SEPARATOR = "--"

function snapshotKey(projectId: string, fileId: string): string {
  return `projects/${projectId}/files/${fileId}/snapshot.bin`
}

function tailPrefix(projectId: string, fileId: string): string {
  return `projects/${projectId}/files/${fileId}/tail/`
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

/**
 * Merge existing snapshot + all tail blobs into a new snapshot, then delete
 * the tails. Idempotent: running it twice in a row is a no-op (second call
 * sees no tails). Reads directly from R2 so it works both when the DO's
 * Y.Doc is warm in memory and when the alarm wakes a cold DO.
 */
async function compactToSnapshot(
  bucket: R2Bucket,
  projectId: string,
  fileId: string
): Promise<number> {
  const prefix = tailPrefix(projectId, fileId)
  const snapKey = snapshotKey(projectId, fileId)

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
  // Per-cell fingerprints from the last successful projection. Lets onSave
  // skip D1 UPSERTs for cells that haven't changed since the previous tail
  // write. Empty on cold start → first onSave projects everything, then diffs.
  private projectedFingerprints = new Map<string, string>()

  async onLoad(): Promise<Y.Doc | void> {
    const { projectId, fileId } = parseDocId(this.name)
    const snap = await this.env.SNAPSHOTS.get(snapshotKey(projectId, fileId))
    if (snap) {
      const buf = new Uint8Array(await snap.arrayBuffer())
      Y.applyUpdate(this.document, buf)
    }

    // Replay tail updates since the last compaction.
    const list = await this.env.SNAPSHOTS.list({ prefix: tailPrefix(projectId, fileId) })
    const keys = list.objects.map((o) => o.key).sort()
    for (const key of keys) {
      const obj = await this.env.SNAPSHOTS.get(key)
      if (!obj) continue
      const buf = new Uint8Array(await obj.arrayBuffer())
      Y.applyUpdate(this.document, buf)
    }
    this.tailCount = keys.length
  }

  async onSave(): Promise<void> {
    const { projectId, fileId } = parseDocId(this.name)
    // Spike strategy: write full state as a new tail object. Compaction merges later.
    // Production may want incremental updates via update-tracking in onMessage; fine as a v2.
    const state = Y.encodeStateAsUpdate(this.document)
    const seq = Date.now().toString().padStart(16, "0")
    const key = `${tailPrefix(projectId, fileId)}${seq}.bin`
    await this.env.SNAPSHOTS.put(key, state)
    this.tailCount += 1

    // Keep the CQRS read model in sync. Projection failure is non-fatal — the
    // tail write is durable and the next onSave (or compaction-time reconcile)
    // will retry. Skip when CODEX_DB isn't bound (spike / dev without D1).
    if (this.env.CODEX_DB) {
      try {
        const full = projectDoc(projectId, fileId, this.document)
        // Only UPSERT cells whose projected fields differ from last tick.
        // File rollup is always written (single cheap row).
        const diffed = diffProjection(full, this.projectedFingerprints)
        await writeProjection(this.env.CODEX_DB, diffed, key)
      } catch (err) {
        // On failure, clear the fingerprint cache so the next onSave does a
        // full projection — otherwise a D1 error + cache retention would
        // leave D1 permanently behind until the DO evicts.
        this.projectedFingerprints.clear()
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
      const removed = await compactToSnapshot(this.env.SNAPSHOTS, projectId, fileId)
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
      const removed = await compactToSnapshot(this.env.SNAPSHOTS, projectId, fileId)
      this.tailCount = Math.max(0, this.tailCount - removed)
    } catch (err) {
      console.warn(`compaction failed for ${this.name}:`, err)
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Admin paths are intercepted before partyserver so its routing
    // doesn't try to treat /admin/... as a party name.
    const adminResponse = await handleAdminRequest(request, env)
    if (adminResponse) return adminResponse

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
