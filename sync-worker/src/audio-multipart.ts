// Direct-to-R2 multipart upload for audio / video / imported media (AQU-1853).
//
// The single-shot `PUT /audio/...` path buffers the whole body with
// `arrayBuffer()` and hashes it in the isolate, which caps an upload at 95 MB
// (MAX_AUDIO_BYTES) — feature-length video is simply rejected, and two large
// PUTs on one isolate can breach the 128 MB memory limit.
//
// This path uploads straight into an R2 multipart upload instead: the client
// splits the file and sends one part per request, so the Worker only ever holds
// a single part (AUDIO_UPLOAD_PART_BYTES) no matter how big the object is.
// Memory is flat in the file size, and the ceiling becomes
// MAX_AUDIO_MULTIPART_BYTES rather than the request-body limit.
//
// Phases, all on the same `/audio/:projectId/:fileId/:audioId` path, selected
// by `?multipart=`:
//
//   POST   ?multipart=create                             -> { uploadId, partSizeBytes }
//   PUT    ?multipart=part&uploadId=..&partNumber=N      -> { partNumber, etag }
//   POST   ?multipart=complete&uploadId=..               -> { ok, key, bytes }
//   DELETE ?multipart=abort&uploadId=..                  -> { ok }
//
// Auth is the same file-scoped sync token the single-shot PUT requires, checked
// on EVERY phase (not just create) at the contributor floor — an upload id is
// not a bearer token, so a viewer who learns one still cannot write parts. The
// `complete` phase records the artifact rows via the shared
// `recordAudioArtifact`, so an imported clip looks identical in Postgres
// whichever upload path produced it.
//
// `sha256` is supplied by the client on `complete` (hashed incrementally while
// parting the file — see src/lib/hash/sha256-stream.ts) because a Worker cannot
// hash a multi-gigabyte object without re-reading it. The uploader already has
// write access and authored the bytes, so this grants it nothing it did not
// already have; the SIZE is verified server-side against what R2 actually
// assembled, so a wrong declared length is always caught.

import { verifyTokenForFile, WRITE_ROLE_LEVEL } from "./auth"
import { loadAudioArtifactConflict, writeAudioArtifactRows } from "./audio-artifact"
import { safeAudioContentType } from "./audio-content-type"
// Type-only: erased at runtime, so this does not create an import cycle
// with `audio.ts` (which imports this module).
import type { AudioEnv } from "./audio"

/** Part size the client is told to use: 16 MB keeps a part well inside the
 *  isolate's memory budget while keeping the part count low (a 2 GB object is
 *  128 parts, far under R2's 10 000-part limit). */
export const AUDIO_UPLOAD_PART_BYTES = 16 * 1024 * 1024

/** Hard limit on a single part the Worker will accept. Larger than the
 *  recommended size so an older client using a bigger part still works, but
 *  small enough that one part can never approach the 128 MB isolate limit. */
export const MAX_AUDIO_PART_BYTES = 64 * 1024 * 1024

/** Ceiling on a complete multipart object. This is the number that replaces
 *  the 95 MB MAX_AUDIO_BYTES for large media; it exists to bound storage and
 *  part counts, not isolate memory. */
export const MAX_AUDIO_MULTIPART_BYTES = 2 * 1024 * 1024 * 1024

/** R2 allows at most 10 000 parts per multipart upload. */
export const MAX_AUDIO_PARTS = 10_000

const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AudioMultipartPhase = "create" | "part" | "complete" | "abort"

export function parseAudioMultipartPhase(raw: string | null): AudioMultipartPhase | null {
  return raw === "create" || raw === "part" || raw === "complete" || raw === "abort"
    ? raw
    : null
}

/**
 * An upload id is opaque to us: R2 mints it and we only ever hand it back to
 * `resumeMultipartUpload`, never interpolate it into a key. So validate only
 * what is safely knowable — a bounded, single-line token — and in particular do
 * NOT reject `/`, `+` or `=`, which appear in real multipart upload ids.
 */
function isPlausibleUploadId(raw: string | null): raw is string {
  // eslint-disable-next-line no-control-regex
  return !!raw && raw.length > 0 && raw.length <= 1024 && !/[\s\u0000-\u001f]/.test(raw)
}

export interface AudioMultipartArgs {
  request: Request
  env: AudioEnv
  url: URL
  projectId: string
  fileId: string
  audioId: string
  key: string
  phase: AudioMultipartPhase
}

interface CompleteBody {
  parts?: unknown
  sha256?: unknown
  sizeBytes?: unknown
  artifactId?: unknown
  artifactName?: unknown
}

/**
 * Handle one multipart phase. Returns a bare Response; the caller adds CORS.
 */
export async function handleAudioMultipart(args: AudioMultipartArgs): Promise<Response> {
  const { request, env, url, projectId, fileId, audioId, key, phase } = args

  // --- auth: every phase, contributor floor, token scoped to this file ---
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return new Response(verified.reason, { status: verified.status })
  if (verified.claims.projectId !== projectId) {
    return new Response("token scoped to different project", { status: 403 })
  }
  if (verified.claims.role < WRITE_ROLE_LEVEL) {
    return new Response("insufficient role", { status: 403 })
  }

  const expectedMethod = phase === "part" ? "PUT" : phase === "abort" ? "DELETE" : "POST"
  if (request.method !== expectedMethod) {
    return new Response(`multipart ${phase} requires ${expectedMethod}`, { status: 405 })
  }

  if (phase === "create") {
    // The client may advertise the total up front; reject an oversize object
    // before a single byte is stored.
    const declaredTotal = request.headers.get("X-Upload-Total-Bytes")
    if (declaredTotal !== null) {
      const total = Number(declaredTotal)
      if (!Number.isFinite(total) || !Number.isInteger(total) || total < 0) {
        return new Response("invalid X-Upload-Total-Bytes", { status: 400 })
      }
      if (total > MAX_AUDIO_MULTIPART_BYTES) {
        return Response.json(
          { error: "audio too large", maxBytes: MAX_AUDIO_MULTIPART_BYTES },
          { status: 413 },
        )
      }
    }
    // The final object's type travels in its own header: this request's
    // Content-Type describes the (empty) create call, not the media.
    const contentType = safeAudioContentType(request.headers.get("X-Upload-Content-Type"))
    const upload = await env.SNAPSHOTS.createMultipartUpload(key, {
      httpMetadata: { contentType },
    })
    return Response.json({
      uploadId: upload.uploadId,
      key,
      partSizeBytes: AUDIO_UPLOAD_PART_BYTES,
      maxBytes: MAX_AUDIO_MULTIPART_BYTES,
    })
  }

  const uploadId = url.searchParams.get("uploadId")
  if (!isPlausibleUploadId(uploadId)) {
    return new Response("missing or invalid uploadId", { status: 400 })
  }

  if (phase === "part") {
    const partNumberRaw = url.searchParams.get("partNumber")
    const partNumber = Number(partNumberRaw)
    if (
      !partNumberRaw
      || !Number.isInteger(partNumber)
      || partNumber < 1
      || partNumber > MAX_AUDIO_PARTS
    ) {
      return new Response("invalid partNumber", { status: 400 })
    }
    // Refuse before buffering when the client advertises the length; the
    // post-buffer check below is the backstop.
    const declaredLength = Number(request.headers.get("Content-Length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_PART_BYTES) {
      return Response.json(
        { error: "part too large", maxBytes: MAX_AUDIO_PART_BYTES },
        { status: 413 },
      )
    }
    const body = await request.arrayBuffer()
    if (body.byteLength === 0) return new Response("part is empty", { status: 400 })
    if (body.byteLength > MAX_AUDIO_PART_BYTES) {
      return Response.json(
        { error: "part too large", maxBytes: MAX_AUDIO_PART_BYTES },
        { status: 413 },
      )
    }
    const upload = env.SNAPSHOTS.resumeMultipartUpload(key, uploadId)
    let uploaded: R2UploadedPart
    try {
      uploaded = await upload.uploadPart(partNumber, body)
    } catch (error) {
      console.error("[audio/multipart] uploadPart failed:", error)
      // A stale/unknown uploadId is the client's problem to restart, not a
      // transient server fault — don't invite an infinite retry loop.
      return new Response("multipart upload not found or part rejected", { status: 409 })
    }
    return Response.json({ partNumber: uploaded.partNumber, etag: uploaded.etag })
  }

  if (phase === "abort") {
    const upload = env.SNAPSHOTS.resumeMultipartUpload(key, uploadId)
    // Aborting an already-gone upload is success from the caller's point of
    // view: the goal is "no dangling parts", and there are none.
    await upload.abort().catch(() => {})
    return Response.json({ ok: true })
  }

  // --- complete ---
  let parsed: CompleteBody
  try {
    parsed = (await request.json()) as CompleteBody
  } catch {
    return new Response("invalid JSON body", { status: 400 })
  }
  if (!Array.isArray(parsed.parts) || parsed.parts.length === 0) {
    return new Response("parts must be a non-empty array", { status: 400 })
  }
  if (parsed.parts.length > MAX_AUDIO_PARTS) {
    return new Response("too many parts", { status: 400 })
  }
  const parts: R2UploadedPart[] = []
  for (const raw of parsed.parts) {
    const part = raw as { partNumber?: unknown; etag?: unknown }
    const partNumber = Number(part.partNumber)
    if (
      !Number.isInteger(partNumber)
      || partNumber < 1
      || partNumber > MAX_AUDIO_PARTS
      || typeof part.etag !== "string"
      || part.etag.length === 0
    ) {
      return new Response("invalid part entry", { status: 400 })
    }
    parts.push({ partNumber, etag: part.etag })
  }

  const artifactId = typeof parsed.artifactId === "string" ? parsed.artifactId.trim() : undefined
  if (artifactId && !UUID_RE.test(artifactId)) {
    return new Response("invalid artifact id", { status: 400 })
  }
  const artifactName = typeof parsed.artifactName === "string" ? parsed.artifactName : undefined
  if (artifactName && artifactName.length > 1024) {
    return new Response("artifact name is too long", { status: 400 })
  }
  const sha256 = typeof parsed.sha256 === "string" ? parsed.sha256.toLowerCase() : undefined
  if (sha256 !== undefined && !SHA256_HEX_RE.test(sha256)) {
    return new Response("invalid sha256", { status: 400 })
  }
  // `artifacts.sha256` is NOT NULL and is how artifact identity is compared,
  // so a provenance-carrying upload has to supply it.
  if (artifactId && !sha256) {
    return new Response("sha256 is required when artifactId is set", { status: 400 })
  }
  // Server-config check last, so a malformed request is still a 4xx.
  if (artifactId && !env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }
  const declaredSize = parsed.sizeBytes === undefined ? undefined : Number(parsed.sizeBytes)
  if (declaredSize !== undefined && (!Number.isInteger(declaredSize) || declaredSize < 0)) {
    return new Response("invalid sizeBytes", { status: 400 })
  }

  const upload = env.SNAPSHOTS.resumeMultipartUpload(key, uploadId)
  let object: R2Object
  try {
    object = await upload.complete(parts)
  } catch (error) {
    console.error("[audio/multipart] complete failed:", error)
    return new Response("multipart complete failed (unknown upload or bad parts)", { status: 409 })
  }

  // Size is the one thing we can verify cheaply and must: it catches a client
  // that mis-declared the length or dropped a part, and enforces the ceiling
  // even when `create` was given no X-Upload-Total-Bytes hint.
  if (object.size > MAX_AUDIO_MULTIPART_BYTES) {
    await env.SNAPSHOTS.delete(key).catch(() => {})
    return Response.json(
      { error: "audio too large", maxBytes: MAX_AUDIO_MULTIPART_BYTES },
      { status: 413 },
    )
  }
  if (declaredSize !== undefined && object.size !== declaredSize) {
    await env.SNAPSHOTS.delete(key).catch(() => {})
    return new Response(
      `assembled object is ${object.size} bytes, client declared ${declaredSize}`,
      { status: 409 },
    )
  }

  if (artifactId) {
    // Unlike the single-shot path, the identity check can only run after
    // `complete()` — the object's bytes (and so its sha256) do not exist until
    // R2 assembles the parts. On conflict the assembled object is left in
    // place rather than deleted: the conflicting artifact row may point at
    // this very key, and deleting it would destroy media that is still
    // referenced. An unreferenced object is picked up by the R2 sweep instead.
    const checked = await loadAudioArtifactConflict(env.AQUILLA_PG!, {
      artifactId, projectId, fileId, audioId, sha256: sha256!,
    })
    if (checked.conflict) {
      return new Response("artifact id already belongs to different media", { status: 409 })
    }
    const written = await writeAudioArtifactRows({
      env,
      projectId,
      fileId,
      audioId,
      key,
      artifactId,
      artifactName,
      contentType: safeAudioContentType(object.httpMetadata?.contentType),
      sizeBytes: object.size,
      sha256: sha256!,
      userId: String(verified.claims.userId),
      existing: checked.existing,
    })
    if (!written.ok) {
      return new Response(written.message, { status: written.status })
    }
  }

  return Response.json({ ok: true, key, bytes: object.size })
}
