// Per-cell audio storage backed by the same R2 bucket as snapshots.
//
// R2 layout:
//   {prefix}projects/{projectId}/files/{fileId}/audio/{audioId}     — raw bytes
//
// Auth: PUT/GET use the same sync-token JWT verification as the WS upgrade
// path (`verifyTokenForFile`). The token's `projectId` and `fileId` claims
// must match the URL params, so a token scoped to one file cannot read or
// overwrite another file's audio. GET additionally accepts the token as a
// `?t=` query param (mirroring the diarization /audio route) because media
// elements (`<audio src>`) cannot attach an Authorization header — the token
// is the same short-lived file-scoped JWT either way, just GET/read-only.
// DELETE is admin-only (Bearer SYNC_SECRET_KEY) and mirrors the snapshot
// admin endpoints' shape.
//
// GET streams the R2 body and honours single `Range: bytes=` requests with
// 206/Content-Range so browsers can start playback before the download
// finishes and seek without refetching the whole object.
//
// The DELETE handler in admin.ts already enumerates everything under
// projects/{pid}/files/{fid}/, so wiping a file naturally wipes its audio.

import { verifyTokenForFile } from "./auth"

export interface AudioEnv {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

export function r2KeyPrefix(env: Pick<AudioEnv, "R2_KEY_PREFIX">): string {
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Parsed single byte-range. `suffix` = last-N-bytes form (`bytes=-N`). */
type ParsedRange = { offset: number; length?: number } | { suffix: number }

/**
 * Parse a `Range` header into an R2 range. Returns null for absent, malformed
 * or multi-range headers — per RFC 9110 a server MAY ignore Range and serve
 * 200, which is what browsers expect and what keeps us off multipart
 * responses (media elements only ever send single ranges).
 */
export function parseRangeHeader(raw: string | null): ParsedRange | null {
  if (!raw) return null
  const m = raw.match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return null
  const [, startStr, endStr] = m
  if (startStr === "" && endStr === "") return null
  if (startStr === "") return { suffix: Number(endStr) }
  const offset = Number(startStr)
  if (endStr === "") return { offset }
  const end = Number(endStr)
  if (end < offset) return null
  return { offset, length: end - offset + 1 }
}

// Reject uploads that would blow past Workers' 100 MB request cap with an
// opaque error. 95 MB leaves headroom for headers while comfortably covering
// real recordings. Mirrored client-side as MAX_AUDIO_UPLOAD_BYTES in
// src/lib/audio/upload.ts — keep the two in sync.
export const MAX_AUDIO_BYTES = 95 * 1024 * 1024

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Artifact-Id, X-Artifact-Name",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
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
    const adminExpected = env.SYNC_SECRET_KEY
      ? `Bearer ${env.SYNC_SECRET_KEY}`
      : null
    if (adminExpected && auth === adminExpected) {
      // Admin DELETE: no extra scope check.
      await env.SNAPSHOTS.delete(key)
      return withAudioCors(Response.json({ ok: true }))
    }
    // F8: also allow the sync-token owner (contributor+) to DELETE — used by the
    // client to clean up an orphaned R2 blob when `emitCellAudioAttach` fails
    // after a successful PUT. The token must be scoped to the same
    // (projectId, fileId) as the URL params.
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null
    const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
    if (!verified.ok) {
      return withAudioCors(new Response("unauthorized", { status: 401 }))
    }
    if (verified.claims.projectId !== projectId) {
      return withAudioCors(
        new Response("token scoped to different project", { status: 403 }),
      )
    }
    await env.SNAPSHOTS.delete(key)
    return withAudioCors(Response.json({ ok: true }))
  }

  // PUT / GET both require a sync-token JWT scoped to (projectId, fileId).
  if (request.method !== "PUT" && request.method !== "GET") {
    return withAudioCors(new Response("method not allowed", { status: 405 }))
  }

  const header = request.headers.get("Authorization") ?? ""
  let token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  // GET-only: accept the sync-token as a `?t=` query param so `<audio src>`
  // can stream directly (media elements cannot send Authorization headers).
  // Writes stay header-only — a URL is too easy to leak into logs/history to
  // let it authorize mutations.
  if (!token && request.method === "GET") {
    token = url.searchParams.get("t")
  }
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
    const artifactId = request.headers.get("X-Artifact-Id")?.trim()
    if (artifactId && !UUID_RE.test(artifactId)) {
      return withAudioCors(new Response("invalid artifact id", { status: 400 }))
    }
    if (artifactId && !env.AQUILLA_PG) {
      return withAudioCors(new Response("AQUILLA_PG binding not configured", { status: 500 }))
    }
    let artifactName: string | undefined
    const encodedArtifactName = request.headers.get("X-Artifact-Name")
    if (encodedArtifactName) {
      try {
        artifactName = decodeURIComponent(encodedArtifactName)
      } catch {
        return withAudioCors(new Response("invalid artifact name", { status: 400 }))
      }
    }
    if (artifactName && artifactName.length > 1024) {
      return withAudioCors(new Response("artifact name is too long", { status: 400 }))
    }
    // Reject oversize uploads before buffering the whole body when the client
    // advertises the size; the post-buffer check below is the backstop.
    // (Mirrors source-upload-route.ts.)
    const tooLarge = () =>
      withAudioCors(
        Response.json(
          { error: "audio too large", maxBytes: MAX_AUDIO_BYTES },
          { status: 413 },
        ),
      )
    const declaredLength = Number(request.headers.get("Content-Length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
      return tooLarge()
    }
    const body = await request.arrayBuffer()
    if (body.byteLength === 0) {
      return withAudioCors(new Response("audio upload is empty", { status: 400 }))
    }
    if (body.byteLength > MAX_AUDIO_BYTES) {
      return tooLarge()
    }
    const contentType = request.headers.get("Content-Type") || "application/octet-stream"
    const digest = artifactId ? await crypto.subtle.digest("SHA-256", body) : null
    const sha256 = digest
      ? Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
      : null
    const existing = artifactId
      ? await env.AQUILLA_PG!.prepare(
          `SELECT id::text AS id, project_id, file_id, audio_id, sha256
             FROM artifacts WHERE id::text = ?`,
        ).bind(artifactId).first<{
          id: string
          project_id: string
          file_id: string | null
          audio_id: string | null
          sha256: string
        }>()
      : null
    if (
      existing
      && (
        existing.project_id !== projectId
        || existing.file_id !== fileId
        || existing.audio_id !== audioId
        || existing.sha256 !== sha256
      )
    ) {
      return withAudioCors(new Response("artifact id already belongs to different media", { status: 409 }))
    }
    await env.SNAPSHOTS.put(key, body, {
      httpMetadata: { contentType },
    })
    if (artifactId) {
      const db = env.AQUILLA_PG!
      try {
        await db.batch([
          db.prepare(
            `INSERT INTO artifacts (
               id, project_id, uploaded_by_user_id, credential_id, name, content_type,
               size_bytes, sha256, r2_key, file_id, kind, audio_id, metadata
             ) VALUES (?::uuid, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'audio', ?, ?::text::jsonb)
             ON CONFLICT (id) DO NOTHING`,
          ).bind(
            artifactId,
            projectId,
            String(verified.claims.userId),
            artifactName ?? audioId,
            contentType,
            body.byteLength,
            sha256!,
            key,
            fileId,
            audioId,
            JSON.stringify({ origin: "browser-media-import" }),
          ),
          db.prepare(
            `INSERT INTO artifact_bindings (
               id, project_id, artifact_id, file_id, binding_role, target_lang,
               member_path, profile_id, profile_version, fidelity, manifest, recipe
             ) VALUES (?::uuid, ?, ?::uuid, ?, 'source', '', '', 'builtin:media', '1',
                       'preserved-only', '{}'::jsonb, NULL)
             ON CONFLICT (artifact_id, file_id, binding_role, target_lang, member_path)
             DO UPDATE SET updated_at = now()`,
          ).bind(crypto.randomUUID(), projectId, artifactId, fileId),
        ])
      } catch (error) {
        if (!existing) await env.SNAPSHOTS.delete(key).catch(() => {})
        return withAudioCors(new Response(
          `audio artifact metadata write failed: ${error instanceof Error ? error.message : String(error)}`,
          { status: 500 },
        ))
      }
    }
    return withAudioCors(
      Response.json({ ok: true, key, bytes: body.byteLength }),
    )
  }

  // GET — stream the R2 body (no full-object buffering) and honour Range.
  const range = parseRangeHeader(request.headers.get("Range"))
  let obj: R2ObjectBody | null
  try {
    obj = range
      ? await env.SNAPSHOTS.get(key, { range })
      : await env.SNAPSHOTS.get(key)
  } catch {
    // R2 throws on an unsatisfiable range (offset past end of object).
    const head = await env.SNAPSHOTS.head(key)
    if (!head) {
      return withAudioCors(new Response("not found", { status: 404 }))
    }
    return withAudioCors(
      new Response("range not satisfiable", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${head.size}`,
          "Accept-Ranges": "bytes",
        },
      }),
    )
  }
  if (!obj) {
    return withAudioCors(new Response("not found", { status: 404 }))
  }
  const contentType =
    obj.httpMetadata?.contentType || "application/octet-stream"
  // Audio objects are addressed by audioId, which is a stable UUIDv7-based
  // identifier that never changes for a given recording. A new recording
  // always gets a new audioId, so the bytes are truly immutable.
  // `private` prevents CDN/shared-proxy caching of authed responses; the
  // browser is safe to cache the full 1-year TTL (CACHE-5).
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
  }
  const size = obj.size
  if (!range) {
    headers["Content-Length"] = String(size)
    return withAudioCors(new Response(obj.body, { status: 200, headers }))
  }
  // 206: derive the served window from the parsed range + total size (R2
  // clamps a too-long `length` to the object end; a too-large suffix serves
  // the whole object).
  const start = "suffix" in range ? Math.max(0, size - range.suffix) : range.offset
  const end =
    "suffix" in range || range.length === undefined
      ? size - 1
      : Math.min(range.offset + range.length, size) - 1
  headers["Content-Length"] = String(end - start + 1)
  headers["Content-Range"] = `bytes ${start}-${end}/${size}`
  return withAudioCors(new Response(obj.body, { status: 206, headers }))
}
