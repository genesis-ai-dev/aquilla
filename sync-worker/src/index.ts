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
