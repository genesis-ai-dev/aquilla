// Per-cell audio storage backed by the same R2 bucket as snapshots.
//
// R2 layout:
//   {prefix}projects/{projectId}/files/{fileId}/audio/{audioId}     — raw bytes
//
// Auth: PUT/GET use the same sync-token JWT verification as the WS upgrade
// path (`verifyTokenForFile`). The token's `projectId` and `fileId` claims
// must match the URL params, so a token scoped to one file cannot read or
// overwrite another file's audio. DELETE is admin-only (Bearer
// SYNC_SECRET_KEY) and mirrors the snapshot admin endpoints' shape.
//
// The DELETE handler in admin.ts already enumerates everything under
// projects/{pid}/files/{fid}/, so wiping a file naturally wipes its audio.

import { verifyTokenForFile } from "./auth"

export interface AudioEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

function r2KeyPrefix(env: Pick<AudioEnv, "R2_KEY_PREFIX">): string {
  const p = env.R2_KEY_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  return p ? `${p}/` : ""
}

/** Build the R2 key for one cell's audio object. `audioId` is the full
 *  filename the client chose (typically `<id>.webm`). */
export function audioObjectKey(
  env: Pick<AudioEnv, "R2_KEY_PREFIX">,
  projectId: string,
  fileId: string,
  audioId: string,
): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/audio/${audioId}`
}

const AUDIO_PATH_RE = /^\/audio\/([^/]+)\/([^/]+)\/([^/]+)$/

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
}

function withAudioCors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

/**
 * Routes /audio/:projectId/:fileId/:audioId.
 *  - OPTIONS  → CORS preflight
 *  - PUT      → store body as the audio object (sync-token auth)
 *  - GET      → return raw bytes (sync-token auth) or 404
 *  - DELETE   → admin only via SYNC_SECRET_KEY
 *
 * Returns null when the URL or method doesn't match so the dispatcher can
 * fall through to the next handler.
 */
export async function handleAudioRequest(
  request: Request,
  env: AudioEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(AUDIO_PATH_RE)
  if (!match) return null

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const audioId = decodeURIComponent(match[3])
  const key = audioObjectKey(env, projectId, fileId, audioId)

  if (request.method === "DELETE") {
    const auth = request.headers.get("Authorization") ?? ""
    const expected = env.SYNC_SECRET_KEY
      ? `Bearer ${env.SYNC_SECRET_KEY}`
      : null
    if (!expected || auth !== expected) {
      return withAudioCors(new Response("unauthorized", { status: 401 }))
    }
    await env.SNAPSHOTS.delete(key)
    return withAudioCors(Response.json({ ok: true }))
  }

  // PUT / GET both require a sync-token JWT scoped to (projectId, fileId).
  if (request.method !== "PUT" && request.method !== "GET") {
    return withAudioCors(new Response("method not allowed", { status: 405 }))
  }

  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return withAudioCors(new Response(verified.reason, { status: verified.status }))
  }
  if (verified.claims.projectId !== projectId) {
    return withAudioCors(
      new Response("token scoped to different project", { status: 403 }),
    )
  }

  if (request.method === "PUT") {
    const body = await request.arrayBuffer()
    const contentType = request.headers.get("Content-Type") || "application/octet-stream"
    await env.SNAPSHOTS.put(key, body, {
      httpMetadata: { contentType },
    })
    return withAudioCors(
      Response.json({ ok: true, key, bytes: body.byteLength }),
    )
  }

  // GET
  const obj = await env.SNAPSHOTS.get(key)
  if (!obj) {
    return withAudioCors(new Response("not found", { status: 404 }))
  }
  const buf = await obj.arrayBuffer()
  const contentType =
    obj.httpMetadata?.contentType || "application/octet-stream"
  return withAudioCors(
    new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    }),
  )
}
