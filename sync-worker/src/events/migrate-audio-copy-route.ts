// POST /migrate/audio-copy — fast R2→R2 audio import (trusted, headless).
//
// The legacy audio bytes already live in this same Cloudflare account, in the
// bucket that backs GitLab LFS (codex-attachments-v1-1), keyed by LFS oid. The
// old /migrate/audio endpoint re-uploaded bytes the migration had pulled back
// out of GitLab — shuttling GBs over the wire to move them between two buckets
// in one account. This endpoint instead copies straight from the LFS bucket
// (bound read-only as LFS_SRC) to the snapshots bucket via the worker's
// bindings, so the bytes never leave Cloudflare's network.
//
// Body: { projectId, fileId, audioId, oid }. The destination key is identical
// to the live audio path (audioObjectKey), so the cell.audio.attach url
// (frontier-audio://<audioId>) resolves + streams from R2 exactly as usual.
//
// Gated on SYNC_SECRET_KEY — same trust tier as /migrate/ingest + /migrate/audio.

import { audioObjectKey } from "../audio"

const RE = /^\/migrate\/audio-copy\/?$/

export interface MigrateAudioCopyEnv {
  /** Destination: the live audio/media bucket. */
  SNAPSHOTS: R2Bucket
  /** Source: GitLab's LFS object-storage bucket, bound read-only. */
  LFS_SRC?: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

/** GitLab stores LFS objects in object storage under an oid-sharded key:
 *  `<oid[0:2]>/<oid[2:4]>/<oid[4:]>` — the two shard dirs use the first 4 hex,
 *  and the object name is the REMAINDER of the oid (not the full oid). Verified
 *  against the live bucket (codex-attachments-v1-1): oid 6adb…d8b5 lives at
 *  6a/db/f08b…d8b5. Isolated here so the layout lives in one place. */
export function gitlabLfsKey(oid: string): string {
  return `${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid.slice(4)}`
}

interface CopyBody {
  projectId?: unknown
  fileId?: unknown
  audioId?: unknown
  oid?: unknown
}

const OID_RE = /^[0-9a-f]{64}$/

export async function handleMigrateAudioCopyRequest(
  request: Request,
  env: MigrateAudioCopyEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!RE.test(url.pathname)) return null
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if ((request.headers.get("Authorization") ?? "") !== `Bearer ${env.SYNC_SECRET_KEY}`) {
    return new Response("unauthorized", { status: 401 })
  }
  if (!env.SNAPSHOTS) return new Response("SNAPSHOTS bucket not bound", { status: 500 })
  if (!env.LFS_SRC) return new Response("LFS_SRC bucket not bound", { status: 500 })

  let body: CopyBody
  try {
    body = (await request.json()) as CopyBody
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 })
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : ""
  const fileId = typeof body.fileId === "string" ? body.fileId : ""
  const audioId = typeof body.audioId === "string" ? body.audioId : ""
  const oid = typeof body.oid === "string" ? body.oid.toLowerCase() : ""
  if (!projectId || !fileId || !audioId || !OID_RE.test(oid)) {
    return Response.json({ error: "projectId, fileId, audioId, and a 64-hex oid are required" }, { status: 400 })
  }

  const destKey = audioObjectKey(env, projectId, fileId, audioId)

  // Idempotent: a prior run (or a parallel one) already placed these bytes.
  const existing = await env.SNAPSHOTS.head(destKey)
  if (existing) return Response.json({ copied: false, reason: "exists", key: destKey })

  const srcKey = gitlabLfsKey(oid)
  const src = await env.LFS_SRC.get(srcKey)
  if (!src) {
    // The pointer referenced an oid that isn't in the LFS bucket. Surfaced to
    // the caller (counted + logged) — never silently dropped.
    return Response.json({ copied: false, reason: "lfs-miss", oid, srcKey }, { status: 404 })
  }

  const contentType = src.httpMetadata?.contentType ?? contentTypeForAudioId(audioId)
  try {
    await env.SNAPSHOTS.put(destKey, src.body, { httpMetadata: { contentType } })
  } catch (err) {
    return Response.json({ copied: false, reason: "put-failed", error: String(err) }, { status: 500 })
  }
  return Response.json({ copied: true, key: destKey })
}

function contentTypeForAudioId(audioId: string): string {
  const ext = audioId.slice(audioId.lastIndexOf(".") + 1).toLowerCase()
  switch (ext) {
    case "webm":
      return "audio/webm"
    case "wav":
      return "audio/wav"
    case "mp3":
      return "audio/mpeg"
    case "m4a":
    case "mp4":
      return "audio/mp4"
    case "ogg":
      return "audio/ogg"
    default:
      return "application/octet-stream"
  }
}
