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
// Token validation is not yet wired in. Anyone who can reach the worker can
// connect to any docId. Tolerable while the worker isn't deployed publicly.

import { YServer } from "y-partyserver"
import type { Connection } from "partyserver"
import * as Y from "yjs"
import { routePartykitRequest } from "partyserver"
import { verifyTokenForDoc } from "./auth"

declare global {
  namespace Cloudflare {
    interface Env {
      FileSync: DurableObjectNamespace
      SNAPSHOTS: R2Bucket
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
  }

  async onSave(): Promise<void> {
    const { projectId, fileId } = parseDocId(this.name)
    // Spike strategy: write full state as a new tail object. Compaction merges later.
    // Production may want incremental updates via update-tracking in onMessage; fine as a v2.
    const state = Y.encodeStateAsUpdate(this.document)
    const seq = Date.now().toString().padStart(16, "0")
    const key = `${tailPrefix(projectId, fileId)}${seq}.bin`
    await this.env.SNAPSHOTS.put(key, state)
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
      await compactToSnapshot(this.env.SNAPSHOTS, projectId, fileId)
    } catch (err) {
      console.warn(`compaction failed for ${this.name}:`, err)
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env, {
        onBeforeConnect: async (req, lobby) => {
          if (env.ALLOW_UNAUTHENTICATED === "true") return
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
        },
      })) ?? new Response("not found", { status: 404 })
    )
  },
}
