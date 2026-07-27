// PUT /migrate/audio/:projectId/:fileId/:audioId — trusted audio upload to R2.
//
// The normal /audio PUT requires a per-file sync-token (a logged-in user). The
// migration runs headless with the service credential, so this variant writes
// the bytes straight to the R2 bucket via the worker's binding, gated on
// SYNC_SECRET_KEY — same trust tier as /migrate/ingest. The object key is
// identical to the live path (audioObjectKey), so the cell.audio.attach url
// (frontier-audio://<audioId>) resolves + streams from R2 exactly as usual.

import { audioObjectKey } from "../audio"
import { secureCompare } from "../lib/secure-compare"

const RE = /^\/migrate\/audio\/([^/]+)\/([^/]+)\/([^/]+)$/

export interface MigrateAudioEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

export async function handleMigrateAudioRequest(
  request: Request,
  env: MigrateAudioEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const m = url.pathname.match(RE)
  if (!m) return null
  if (request.method !== "PUT") return new Response("method not allowed", { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if (!secureCompare(request.headers.get("Authorization") ?? "", `Bearer ${env.SYNC_SECRET_KEY}`)) {
    return new Response("unauthorized", { status: 401 })
  }
  if (!env.SNAPSHOTS) return new Response("R2 bucket not bound", { status: 500 })

  const projectId = decodeURIComponent(m[1])
  const fileId = decodeURIComponent(m[2])
  const audioId = decodeURIComponent(m[3])
  const key = audioObjectKey(env, projectId, fileId, audioId)
  const body = await request.arrayBuffer()
  const contentType = request.headers.get("Content-Type") || "application/octet-stream"
  try {
    await env.SNAPSHOTS.put(key, body, { httpMetadata: { contentType } })
  } catch (err) {
    return Response.json({ error: `R2 put failed: ${String(err)}` }, { status: 500 })
  }
  return Response.json({ ok: true, key, bytes: body.byteLength })
}
