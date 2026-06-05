// Original-import blob storage backed by the SNAPSHOTS R2 bucket.
//
// R2 layout:
//   {prefix}projects/{projectId}/files/{fileId}/source  — raw bytes of the
//                                                          imported original
//
// Auth: PUT/GET use the same sync-token JWT as the audio and bulk-import
// routes. The token's projectId + fileId claims must match the URL params.
//
// No size limit (unlike the D1 TEXT-column side-car approach from FRO-152).
// Storing in R2 lets arbitrarily large DOCX/PPTX files round-trip without
// hitting D1's 1 MB row ceiling — the motivation for FRO-156.

import { verifyTokenForFile } from "./auth"
import { r2KeyPrefix, type AudioEnv } from "./audio"
import { withCors } from "./cors"

export type SourceBlobEnv = AudioEnv

/** R2 key for a file's original-import blob. */
export function sourceBlobKey(
  env: Pick<SourceBlobEnv, "R2_KEY_PREFIX">,
  projectId: string,
  fileId: string,
): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/source`
}

const SOURCE_BLOB_PATH_RE = /^\/source-blob\/([^/]+)\/([^/]+)$/

/**
 * Routes /source-blob/:projectId/:fileId
 *  - OPTIONS → CORS preflight
 *  - PUT     → store body as the file's original-import blob (sync-token auth)
 *              Returns { ok: true, r2Key: string, bytes: number }
 *  - GET     → return raw bytes (sync-token auth) or 404
 *
 * Returns null when the URL doesn't match so the dispatcher falls through.
 */
export async function handleSourceBlobRequest(
  request: Request,
  env: SourceBlobEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(SOURCE_BLOB_PATH_RE)
  if (!match) return null

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    })
  }

  if (request.method !== "PUT" && request.method !== "GET") {
    return withCors(new Response("method not allowed", { status: 405 }), request)
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return withCors(new Response(verified.reason, { status: verified.status }), request)
  }
  if (verified.claims.projectId !== projectId) {
    return withCors(
      new Response("token scoped to different project", { status: 403 }),
      request,
    )
  }

  const key = sourceBlobKey(env, projectId, fileId)

  if (request.method === "PUT") {
    const body = await request.arrayBuffer()
    const contentType = request.headers.get("Content-Type") || "application/octet-stream"
    await env.SNAPSHOTS.put(key, body, {
      httpMetadata: { contentType },
    })
    return withCors(
      Response.json({ ok: true, r2Key: key, bytes: body.byteLength }),
      request,
    )
  }

  // GET
  const obj = await env.SNAPSHOTS.get(key)
  if (!obj) {
    return withCors(new Response("not found", { status: 404 }), request)
  }
  const buf = await obj.arrayBuffer()
  const contentType = obj.httpMetadata?.contentType || "application/octet-stream"
  return withCors(
    new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    }),
    request,
  )
}
