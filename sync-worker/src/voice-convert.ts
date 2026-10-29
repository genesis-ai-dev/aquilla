// Voice-convert proxy: re-voice cell audio into a trained RVC voice — a
// character voice from the library or a custom voice trained from an org's own
// recordings — using the voice forge GPU endpoint (infra/modal/voice_forge.py).
//
// The browser never talks to Modal directly — it can't hold the Modal secret.
// Instead the client posts a small request here; this worker resolves the
// source clip, calls Modal with the shared secret, writes the converted wav
// back to R2, and returns an audioId the client attaches to the cell.
//
//   source    — the speech to keep. Either an inline `source` file (fresh
//               TTS output) or `sourceAudioId` for an existing recording
//               already in R2 under this file.
//   voice     — `libraryVoiceId`, the trained RVC model's id on Modal.
//   output    — written as a new cell-audio object under the file, same R2
//               layout + frontier-audio:// URL scheme as client-side uploads.
//
// Auth mirrors the /audio handler exactly: a sync-token JWT scoped to
// (projectId, fileId).
//
// AQU-2291: this route used to have a second, short-clip path — Seed-VC
// re-voicing against a project-scoped reference clip (`referenceAudioId`).
// Short-clip clone voices were removed product-wide; a real person's voice now
// has to be trained as a custom voice (custom-voice.ts). A request still
// carrying `referenceAudioId` gets a 400 that says so. The project-scoped
// reference-clip store below stays: custom-voice training reads its recordings
// from it and Inworld voice-design previews are kept there.

import { audioObjectKey, isPathSafeId, r2KeyPrefix, safeAudioContentType } from "./audio"
import { verifyTokenForFile, verifyTokenForProject, WRITE_ROLE_LEVEL } from "./auth"
import { LIBRARY_VOICE_CONVERT_GPU, modalGpuRawCents } from "../../db/shared/audio-price-card"
import { entitleProjectAiCall, releaseQuietly, settleQuietly } from "./ai-metering"
// Shared with the Inworld proxy: both bound their one upstream subrequest with
// AbortSignal.timeout and need the same DOMException check to tell a blown
// deadline apart from a dead upstream.
import { isAbortTimeout } from "./inworld-tts"
import { logVendorTimeout, VENDOR_TIMEOUT_MS } from "../../shared/vendor-timeouts"
import { enforceRateLimit, userRateLimitIdentifier } from "../../db/shared/rate-limit"
import { customVoiceBelongsTo, isCustomVoiceId } from "./custom-voice"

export interface VoiceConvertEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  /** Voice-forge Modal endpoint for library + custom voices, e.g. https://<acct>--voice-forge-web.modal.run/convert */
  VOICE_FORGE_URL?: string
  /** Shared secret matching the Modal `voice-forge-auth` secret's VOICE_FORGE_TOKEN. */
  VOICE_FORGE_TOKEN?: string
  /** Postgres shim — backs the per-user conversion throttle (AQU-1854)
   *  and the platform spend ceiling (AQU-1869). */
  AQUILLA_PG?: AquillaDb
  /** Platform-wide daily AI spend ceiling in USD (AQU-1869). */
  AI_DAILY_SPEND_CEILING_USD?: string
  /** Deployment profile; "test" bypasses the spend-ceiling read cache. */
  ENVIRONMENT?: string
  /** off | shadow | enforce (db/shared/ai-entitlement.ts, AQU-2061). */
  BILLING_METER_MODE?: string
}

// AQU-1854: ceiling on every clip this route (and the reference-clip store)
// buffers. Conversion holds more than one object at a time — the source goes
// up to Modal and the converted wav comes back — so it cannot inherit /audio's
// 95 MB MAX_AUDIO_BYTES, several concurrent copies of which would blow the
// Worker's 128 MB heap. 20 MB is ~20 minutes of 64 kbps mono, far past the
// single-cell clips this feature re-voices. Custom-voice training reuses it as
// its per-recording cap.
export const MAX_VOICE_CLIP_BYTES = 20 * 1024 * 1024

/** Whole-request ceiling for the multipart POST: one clip plus form overhead. */
export const MAX_VOICE_CONVERT_REQUEST_BYTES = MAX_VOICE_CLIP_BYTES + 1024 * 1024

/**
 * AQU-1854: hard deadline on the one voice-forge subrequest. Generous enough
 * for a cold container to load the voice model off the Volume and convert a
 * long clip, far below Modal's own function timeout — so a hung GPU returns
 * this 504 instead of pinning a Worker invocation until the platform kills it
 * with no diagnosis. The number lives in `shared/vendor-timeouts.ts` alongside
 * every other vendor deadline (AQU-1849).
 */
export const VOICE_CONVERT_REQUEST_TIMEOUT_MS = VENDOR_TIMEOUT_MS.modalVoiceConvert

/**
 * AQU-1854: per-user sliding window (15 min, shared primitive with the TTS and
 * Agent-API throttles). Every call starts billed GPU time, so this sits
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

/** Library voice ids are voice_forge.py voice dirs: `[a-z0-9][a-z0-9_-]{1,40}`. */
const LIBRARY_VOICE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/

/**
 * What a converted clip's fingerprint is taken over: the voice's model id,
 * namespaced (it once had to stay apart from clone voices' reference-clip ids,
 * and legacy takes still carry those fingerprints). Mirrored by
 * `voiceConversionKey` in src/lib/audio/change-voice.ts.
 */
export function libraryVoiceKey(libraryVoiceId: string): string {
  return `library:${libraryVoiceId}`
}

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
 * voice clips: custom-voice training recordings (custom-voice.ts reads them by
 * this key) and Inworld voice-design previews. Auth is a
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
    // Overwriting one of the project's shared voice clips is a
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

/**
 * FNV-1a (32-bit) of a voice key (`libraryVoiceKey`), as 8 hex chars. Mirrored
 * by `voiceReferenceFingerprint` in src/lib/audio/change-voice.ts — the client
 * reads it back out of the audioId to tell which voice a converted take was
 * made with. Change both or neither.
 */
export function voiceReferenceFingerprint(voiceKey: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < voiceKey.length; i++) {
    h ^= voiceKey.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Object id for a converted clip. With a `cellId` (Change voice on an existing
 * take) it is `vc-<fingerprint>-audio-<cellId>-…`: seeded with the cell id like
 * every other take (the client's `audioIdSeededWith` tells a cell's own take
 * from the shared imported clip that way), and carrying which voice produced
 * it. Takes made before AQU-2291 also carry a `-q<steps>-` Seed-VC quality
 * stamp after the fingerprint; the client still parses both shapes. Without a
 * cellId it keeps the legacy `audio-clone-` name.
 */
export function convertedAudioId(voiceKey: string, cellId: string | null): string {
  const ts = Date.now()
  const rnd = crypto.randomUUID().slice(0, 8)
  if (!cellId) return `audio-clone-${ts}-${rnd}`
  const seed = cellId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
  return `vc-${voiceReferenceFingerprint(voiceKey)}-audio-${seed}-${ts}-${rnd}`
}

/**
 * POST /api/v1/voice/convert (multipart/form-data)
 *   fields: projectId, fileId, libraryVoiceId, [sourceAudioId], [cellId]
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
  const libraryVoiceId = String(form.get("libraryVoiceId") ?? "")
  const sourceAudioId = form.get("sourceAudioId")
  const sourceEntry = form.get("source")
  // AQU-2291: a stale client still re-voicing through a short-clip clone voice.
  // Checked first so it gets the actionable message rather than "missing
  // libraryVoiceId".
  if (form.get("referenceAudioId")) {
    return new Response(
      "clone voices were removed; train a custom voice from at least 5 minutes of recordings",
      { status: 400 },
    )
  }
  if (!projectId || !fileId || !libraryVoiceId) {
    return new Response("missing projectId, fileId, or libraryVoiceId", { status: 400 })
  }
  // projectId/fileId are form fields (unlike /audio, whose ids are URL-path
  // segments matched by `[^/]+`) and land directly in an R2 key below, so
  // reject anything that could act as a path separator there.
  if (!isPathSafeId(projectId) || !isPathSafeId(fileId)) {
    return new Response("invalid projectId or fileId", { status: 400 })
  }
  if (!LIBRARY_VOICE_ID_RE.test(libraryVoiceId)) {
    return new Response("invalid libraryVoiceId", { status: 400 })
  }
  const upstreamUrl = env.VOICE_FORGE_URL
  const upstreamToken = env.VOICE_FORGE_TOKEN
  if (!upstreamUrl || !upstreamToken) {
    return new Response("voice conversion not configured", { status: 503 })
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
  // Conversion spends real GPU money (the voice forge on Modal) — require the same
  // CONTRIBUTOR floor as cell.audio.attach so a viewer/commenter/reviewer
  // token can't trigger billed work.
  if (verified.claims.role < WRITE_ROLE_LEVEL) {
    return new Response("insufficient role", { status: 403 })
  }
  // A custom voice is a real person's voice, trained under one project's consent
  // record (custom-voice.ts). It is usable only from that project.
  if (isCustomVoiceId(libraryVoiceId)
    && !(await customVoiceBelongsTo(env, projectId, libraryVoiceId))) {
    return new Response("voice not found in this project", { status: 404 })
  }

  // AQU-1854: per-user throttle. Unlike TTS this route had no volumetric
  // control of any kind, so one contributor looping requests could hold open
  // as many GPU containers as Modal would start. Fails CLOSED when the
  // database is unbound: unmetered GPU spend is the worse failure mode.
  // AQU-1843: one atomic check-and-consume, and fail CLOSED on a limiter
  // outage for the same reason — this starts a paid GPU container.
  const db = env.AQUILLA_PG
  if (!db) return new Response("database not configured", { status: 500 })
  const conversionLimit = await enforceRateLimit(db, {
    kind: "voice_convert",
    identifier: userRateLimitIdentifier(verified.claims.userId),
    limit: VOICE_CONVERT_MAX_PER_USER_PER_WINDOW,
    failMode: "closed",
  })
  if (!conversionLimit.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Too many requests, slow down." },
      { status: 429, headers: { "Retry-After": String(conversionLimit.retryAfterSeconds) } },
    )
  }

  // Resolve the source clip: inline upload, or an existing R2 recording.
  //
  // AQU-1854: both branches hand Modal the Blob they already hold rather than
  // round-tripping through an ArrayBuffer and a second Blob. That halves what
  // this route keeps resident per input — Modal reads the bytes and writes
  // them to a wav regardless of the declared type, so the
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

  // Build the Modal request: source + the trained voice's id. The shared
  // secret travels in X-Auth-Token, never to the browser.
  const modalForm = new FormData()
  modalForm.append("source", sourceBlob, "source")
  modalForm.append("voice_id", libraryVoiceId)
  const gpu = LIBRARY_VOICE_CONVERT_GPU

  // The one entitlement check (AQU-2065), which also runs the platform daily
  // spend ceiling (AQU-1869): nothing paid starts once the floor is hit. GPU
  // work stays metered even for a BYOK org (spec Q9). The bound is a run that
  // lasts until our timeout; settlement uses the time the call took.
  const entitled = await entitleProjectAiCall(db, env, {
    projectId, userId: verified.claims.userId, rail: "gpu", provider: "modal", houseKey: upstreamToken,
    estimateRawCents: modalGpuRawCents(gpu, VOICE_CONVERT_REQUEST_TIMEOUT_MS / 1000),
    requestId: crypto.randomUUID(),
  })
  if (!entitled.ok) return entitled.response
  const { grant } = entitled
  const gpuCost = (startedAt: number) => modalGpuRawCents(gpu, (Date.now() - startedAt) / 1000)

  let modalRes: Response
  const startedAt = Date.now()
  try {
    modalRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "X-Auth-Token": grant.key.apiKey },
      body: modalForm,
      // AQU-1854: without this a hung GPU held the Worker invocation open until
      // the platform killed it, which surfaced as a spinner that never resolved
      // rather than an error the user could retry.
      signal: AbortSignal.timeout(VOICE_CONVERT_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // A timeout or dropped connection may follow GPU work: the reservation
    // stays held for reconciliation.
    if (isAbortTimeout(err)) {
      logVendorTimeout("modalVoiceConvert", err)
      return new Response(
        `voice conversion upstream did not respond within ${Math.round(VOICE_CONVERT_REQUEST_TIMEOUT_MS / 1000)}s`,
        { status: 504 },
      )
    }
    console.error("[voice-convert] upstream unreachable:", err)
    return new Response("voice conversion upstream unreachable", { status: 502 })
  }
  if (!modalRes.ok) {
    const detail = await modalRes.text().catch(() => "")
    // The voice forge checks the token and the form before it touches the
    // GPU, so a 4xx other than 408 is proven free; anything
    // else may have run.
    if (modalRes.status >= 400 && modalRes.status < 500 && modalRes.status !== 408) {
      await releaseQuietly(grant, "voice-convert")
    } else {
      await settleQuietly(grant, gpuCost(startedAt), "voice-convert")
    }
    // A custom voice still training is the caller's to wait out, not an outage.
    return new Response(`voice conversion failed (${modalRes.status}): ${detail}`.trim(), {
      status: modalRes.status === 409 ? 409 : 502,
    })
  }
  const convertedBytes = await modalRes.arrayBuffer()
  await settleQuietly(grant, gpuCost(startedAt), "voice-convert")

  // Write the result as a new cell-audio object (same layout as client uploads),
  // so the client only needs to attach the returned audioId.
  const cellIdField = form.get("cellId")
  const cellId = typeof cellIdField === "string" && cellIdField ? cellIdField : null
  const audioId = convertedAudioId(libraryVoiceKey(libraryVoiceId), cellId)
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
