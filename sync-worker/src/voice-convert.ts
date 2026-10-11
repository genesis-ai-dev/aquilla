// Voice-clone proxy: re-voice cell audio into a saved voice profile's timbre
// using the Seed-VC GPU endpoint (infra/modal/seed_vc.py).
//
// The browser never talks to Modal directly — it can't hold the Modal secret,
// and shipping two wavs from the client is wasteful. Instead the client posts a
// small request here; this worker assembles the two inputs Seed-VC needs
// (source + reference), calls Modal with the shared secret, writes the converted
// wav back to R2, and returns an audioId the client attaches to the cell.
//
//   source    — the speech to keep. Either an inline `source` file (fresh
//               Gemini/MMS TTS output) or `sourceAudioId` for an existing
//               recording already in R2 under this file.
//   reference — the voice profile's reference clip, stored project-scoped at
//               {prefix}projects/{projectId}/voices/{referenceAudioId}.
//   output    — written as a new cell-audio object under the file, same R2
//               layout + frontier-audio:// URL scheme as client-side uploads.
//
// Auth mirrors the /audio handler exactly: a sync-token JWT scoped to
// (projectId, fileId). Reading the project-scoped reference clip is gated by the
// verified projectId claim.

import { audioObjectKey, isPathSafeId, r2KeyPrefix, safeAudioContentType } from "./audio"
import { verifyTokenForFile, verifyTokenForProject, WRITE_ROLE_LEVEL } from "./auth"
// Shared with the Inworld proxy: both bound their one upstream subrequest with
// AbortSignal.timeout and need the same DOMException check to tell a blown
// deadline apart from a dead upstream.
import { isAbortTimeout } from "./inworld-tts"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../db/shared/rate-limit"

export interface VoiceConvertEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  /** Seed-VC Modal endpoint, e.g. https://<acct>--seed-vc-web.modal.run/convert */
  SEED_VC_URL?: string
  /** Shared secret matching the Modal `seed-vc-auth` secret's SEED_VC_TOKEN. */
  SEED_VC_TOKEN?: string
  /** Postgres shim — backs the per-user conversion throttle (AQU-1854). */
  AQUILLA_PG?: AquillaDb
}

// AQU-1854: ceiling on every clip this route buffers. Conversion is the one
// audio path that holds more than one object at a time — source + reference go
// up to Modal and the converted wav comes back — so it cannot inherit /audio's
// 95 MB MAX_AUDIO_BYTES, which three concurrent copies of would blow the
// Worker's 128 MB heap on its own. 20 MB is ~20 minutes of 64 kbps mono, far
// past the single-cell clips this feature re-voices, and comfortably above the
// 8 MB the recorder already enforces client-side for reference clips
// (MAX_REFERENCE_BYTES in src/components/VoiceCloneSection.tsx).
export const MAX_VOICE_CLIP_BYTES = 20 * 1024 * 1024

/** Whole-request ceiling for the multipart POST: one clip plus form overhead. */
export const MAX_VOICE_CONVERT_REQUEST_BYTES = MAX_VOICE_CLIP_BYTES + 1024 * 1024

/**
 * AQU-1854: hard deadline on the one Seed-VC subrequest. Generous enough for a
 * cold L40S container to load the checkpoints off the Volume and run 50
 * diffusion steps, far below Modal's own 600 s function timeout — so a hung
 * GPU returns this 504 instead of pinning a Worker invocation until the
 * platform kills it with no diagnosis.
 */
export const SEED_VC_REQUEST_TIMEOUT_MS = 120_000

/**
 * AQU-1854: per-user sliding window (15 min, shared primitive with the TTS and
 * Agent-API throttles). Every call starts billed L40S GPU time, so this sits
 * well below TTS synthesis' 200: a contributor re-voicing a chapter in one
 * sitting never trips it, a scripted loop stops costing money after a minute.
 */
export const VOICE_CONVERT_MAX_PER_USER_PER_WINDOW = 60

/** 413 naming which input blew the cap. "too large" + the bracketed status is
 *  what categorizeAiError's `request-too-large` branch reads client-side. */
function clipTooLarge(what: string): Response {
  const mb = Math.round(MAX_VOICE_CLIP_BYTES / (1024 * 1024))
  return Response.json(
    {
      error: "audio too large",
      input: what,
      maxBytes: MAX_VOICE_CLIP_BYTES,
      message: `${what} is too large for voice conversion (limit ${mb} MB). Trim the clip or use a compressed format like mp3.`,
    },
    { status: 413 },
  )
}

const VOICE_CONVERT_PATH = "/api/v1/voice/convert"

/** R2 key for a project's reference voice clip (project-scoped, not per-file). */
export function voiceRefObjectKey(
  env: Pick<VoiceConvertEnv, "R2_KEY_PREFIX">,
  projectId: string,
  referenceAudioId: string,
): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/voices/${referenceAudioId}`
}

const VOICE_REF_PATH_RE = /^\/api\/v1\/voice\/reference\/([^/]+)\/([^/]+)$/

/**
 * GET/PUT /api/v1/voice/reference/:projectId/:referenceAudioId — project-scoped
 * voice-clone reference clips (the timbre a clone Voice points at). Auth is a
 * sync-token for the project (verifyTokenForProject); reference clips aren't
 * tied to a single file, so any of the project's files' tokens work. Returns
 * null when the path/method doesn't match so the dispatcher falls through.
 */
export async function handleVoiceReferenceRequest(
  request: Request,
  env: VoiceConvertEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(VOICE_REF_PATH_RE)
  if (!match) return null
  if (request.method !== "PUT" && request.method !== "GET") {
    return new Response("method not allowed", { status: 405 })
  }

  const projectId = decodeURIComponent(match[1])
  const referenceAudioId = decodeURIComponent(match[2])
  // [Pen test] Input validation & injection (2026-09-02): both segments are
  // decoded *after* the `[^/]+` path match, so a %2f/%2e%2e%2f-encoded value
  // can smuggle a "/" or ".." into the decoded id and land directly in the R2
  // key below — same class of bug as the /audio route's isPathSafeId fix.
  if (!isPathSafeId(projectId) || !isPathSafeId(referenceAudioId)) {
    return new Response("invalid projectId or referenceAudioId", { status: 400 })
  }

  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }

  const key = voiceRefObjectKey(env, projectId, referenceAudioId)

  if (request.method === "PUT") {
    // Overwriting the project's shared voice-clone reference clip is a
    // contributor-level action, same floor as attaching cell audio — a
    // viewer-role member must not be able to clobber it for the whole project.
    if (verified.claims.role < WRITE_ROLE_LEVEL) {
      return new Response("insufficient role", { status: 403 })
    }
    // AQU-1854: this PUT buffered the whole body with no size check at all —
    // the only unbounded audio write left in the worker. Reject on the declared
    // length first (mirrors /audio's PUT), then backstop after buffering, since
    // Content-Length is advisory.
    const declaredRefLength = Number(request.headers.get("Content-Length"))
    if (Number.isFinite(declaredRefLength) && declaredRefLength > MAX_VOICE_CLIP_BYTES) {
      return clipTooLarge("reference clip")
    }
    const body = await request.arrayBuffer()
    if (body.byteLength > MAX_VOICE_CLIP_BYTES) {
      return clipTooLarge("reference clip")
    }
    // [Pen test] Input validation & injection (2026-08-26): same deny-list fix
    // as /audio — this route stored the client-declared Content-Type verbatim
    // and served it back unsanitized.
    const contentType = safeAudioContentType(request.headers.get("Content-Type"))
    await env.SNAPSHOTS.put(key, body, { httpMetadata: { contentType } })
    return Response.json({ ok: true, referenceAudioId, bytes: body.byteLength })
  }

  // GET
  const obj = await env.SNAPSHOTS.get(key)
  if (!obj) return new Response("not found", { status: 404 })
  const buf = await obj.arrayBuffer()
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": safeAudioContentType(obj.httpMetadata?.contentType),
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  })
}

function clampSteps(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return 10
  return Math.min(50, Math.max(1, n))
}

/**
 * POST /api/v1/voice/convert (multipart/form-data)
 *   fields: projectId, fileId, referenceAudioId, [sourceAudioId], [cellId],
 *           [diffusionSteps]
 *   files:  [source]  — required unless sourceAudioId is given
 *
 * Returns { ok, audioId, ext, objectName, url, bytes }. Returns null when the
 * path/method doesn't match so the dispatcher falls through.
 */
export async function handleVoiceConvertRequest(
  request: Request,
  env: VoiceConvertEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== VOICE_CONVERT_PATH) return null
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }
  if (!env.SEED_VC_URL || !env.SEED_VC_TOKEN) {
    return new Response("voice conversion not configured", { status: 503 })
  }

  // AQU-1854: formData() buffers the entire multipart body, so the declared
  // length is checked before parsing rather than after. The per-clip checks
  // below are the backstop for a missing or lying Content-Length.
  const declaredLength = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VOICE_CONVERT_REQUEST_BYTES) {
    return clipTooLarge("source clip")
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return new Response("expected multipart/form-data", { status: 400 })
  }

  const projectId = String(form.get("projectId") ?? "")
  const fileId = String(form.get("fileId") ?? "")
  const referenceAudioId = String(form.get("referenceAudioId") ?? "")
  const sourceAudioId = form.get("sourceAudioId")
  const sourceEntry = form.get("source")
  if (!projectId || !fileId || !referenceAudioId) {
    return new Response("missing projectId, fileId, or referenceAudioId", { status: 400 })
  }
  // projectId/fileId/referenceAudioId are form fields (unlike /audio, whose
  // ids are URL-path segments matched by `[^/]+`) and land directly in an R2
  // key below, so reject anything that could act as a path separator there.
  if (!isPathSafeId(projectId) || !isPathSafeId(fileId) || !isPathSafeId(referenceAudioId)) {
    return new Response("invalid projectId, fileId, or referenceAudioId", { status: 400 })
  }

  // Auth: sync-token scoped to this (projectId, fileId), same as /audio.
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }
  if (verified.claims.projectId !== projectId) {
    return new Response("token scoped to different project", { status: 403 })
  }
  // Conversion spends real GPU money (Seed-VC on Modal) — require the same
  // CONTRIBUTOR floor as cell.audio.attach so a viewer/commenter/reviewer
  // token can't trigger billed work.
  if (verified.claims.role < WRITE_ROLE_LEVEL) {
    return new Response("insufficient role", { status: 403 })
  }

  // AQU-1854: per-user throttle. Unlike TTS this route had no volumetric
  // control of any kind, so one contributor looping requests could hold open
  // as many L40S containers as Modal would start. Fails CLOSED when the
  // database is unbound: unmetered GPU spend is the worse failure mode.
  const db = env.AQUILLA_PG
  if (!db) return new Response("database not configured", { status: 500 })
  const rateLimitIdentifier = `user:${verified.claims.userId}`
  const recentConversions = await countRecentRateLimitEvents(db, "voice_convert", rateLimitIdentifier)
  if (recentConversions >= VOICE_CONVERT_MAX_PER_USER_PER_WINDOW) {
    return Response.json(
      { error: "rate_limited", message: "Too many requests, slow down." },
      { status: 429 },
    )
  }
  await recordRateLimitEvent(db, "voice_convert", rateLimitIdentifier)

  // Resolve the source clip: inline upload, or an existing R2 recording.
  //
  // AQU-1854: both branches hand Modal the Blob they already hold rather than
  // round-tripping through an ArrayBuffer and a second Blob. That halves what
  // this route keeps resident per input — Modal reads the bytes and writes
  // them to source.wav/reference.wav regardless of the declared type, so the
  // re-wrap was only ever carrying metadata nothing downstream reads.
  let sourceBlob: Blob
  if (sourceEntry && typeof sourceEntry !== "string") {
    // A Blob/File upload (workers-types models the non-string entry as Blob).
    sourceBlob = sourceEntry as Blob
    if (sourceBlob.size > MAX_VOICE_CLIP_BYTES) return clipTooLarge("source clip")
  } else if (typeof sourceAudioId === "string" && sourceAudioId) {
    // sourceAudioId is a form field (unlike /audio's URL-path ids) and lands
    // directly in an R2 key via audioObjectKey — see audio.ts's isPathSafeId
    // doc comment, which names this exact call site.
    if (!isPathSafeId(sourceAudioId)) {
      return new Response("invalid sourceAudioId", { status: 400 })
    }
    const obj = await env.SNAPSHOTS.get(audioObjectKey(env, projectId, fileId, sourceAudioId))
    if (!obj) return new Response("source audio not found", { status: 404 })
    // R2 reports the object size without reading it, so an oversize stored
    // recording is rejected before any of it reaches the Worker heap.
    if (obj.size > MAX_VOICE_CLIP_BYTES) return clipTooLarge("stored source recording")
    sourceBlob = await obj.blob()
    if (sourceBlob.size > MAX_VOICE_CLIP_BYTES) return clipTooLarge("stored source recording")
  } else {
    return new Response("provide a source file or sourceAudioId", { status: 400 })
  }

  // Resolve the reference clip (project-scoped).
  const refObj = await env.SNAPSHOTS.get(voiceRefObjectKey(env, projectId, referenceAudioId))
  if (!refObj) return new Response("reference audio not found", { status: 404 })
  if (refObj.size > MAX_VOICE_CLIP_BYTES) return clipTooLarge("reference clip")
  const refBlob = await refObj.blob()
  if (refBlob.size > MAX_VOICE_CLIP_BYTES) return clipTooLarge("reference clip")

  // Call Seed-VC on Modal. It expects multipart source + reference and returns
  // a wav. The shared secret travels in X-Auth-Token, never to the browser.
  const modalForm = new FormData()
  modalForm.append("source", sourceBlob, "source")
  modalForm.append("reference", refBlob, "reference")
  modalForm.append("diffusion_steps", String(clampSteps(form.get("diffusionSteps"))))

  let modalRes: Response
  try {
    modalRes = await fetch(env.SEED_VC_URL, {
      method: "POST",
      headers: { "X-Auth-Token": env.SEED_VC_TOKEN },
      body: modalForm,
      // AQU-1854: without this a hung GPU held the Worker invocation open until
      // the platform killed it, which surfaced as a spinner that never resolved
      // rather than an error the user could retry.
      signal: AbortSignal.timeout(SEED_VC_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    if (isAbortTimeout(err)) {
      console.error("[voice-convert] upstream timed out:", err)
      return new Response(
        `voice conversion upstream did not respond within ${Math.round(SEED_VC_REQUEST_TIMEOUT_MS / 1000)}s`,
        { status: 504 },
      )
    }
    console.error("[voice-convert] upstream unreachable:", err)
    return new Response("voice conversion upstream unreachable", { status: 502 })
  }
  if (!modalRes.ok) {
    const detail = await modalRes.text().catch(() => "")
    return new Response(`voice conversion failed (${modalRes.status}): ${detail}`.trim(), {
      status: 502,
    })
  }
  const convertedBytes = await modalRes.arrayBuffer()

  // Write the result as a new cell-audio object (same layout as client uploads),
  // so the client only needs to attach the returned audioId.
  const audioId = `audio-clone-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const ext = "wav"
  const objectName = `${audioId}.${ext}`
  await env.SNAPSHOTS.put(audioObjectKey(env, projectId, fileId, objectName), convertedBytes, {
    httpMetadata: { contentType: "audio/wav" },
  })

  return Response.json({
    ok: true,
    audioId,
    ext,
    objectName,
    url: `frontier-audio://${objectName}`,
    bytes: convertedBytes.byteLength,
  })
}
