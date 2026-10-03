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

export interface VoiceConvertEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  /** Seed-VC Modal endpoint, e.g. https://<acct>--seed-vc-web.modal.run/convert */
  SEED_VC_URL?: string
  /** Shared secret matching the Modal `seed-vc-auth` secret's SEED_VC_TOKEN. */
  SEED_VC_TOKEN?: string
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
    const body = await request.arrayBuffer()
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
 * FNV-1a (32-bit) of a reference clip id, as 8 hex chars. Mirrored by
 * `voiceReferenceFingerprint` in src/lib/audio/change-voice.ts — the client
 * reads it back out of the audioId to tell whether a converted take was made
 * from the voice's CURRENT reference clip. Change both or neither.
 */
export function voiceReferenceFingerprint(referenceAudioId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < referenceAudioId.length; i++) {
    h ^= referenceAudioId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Object id for a converted clip. With a `cellId` (Change voice on an existing
 * take) it is `vc-<fingerprint>-q<steps>-audio-<cellId>-…`: seeded with the
 * cell id like every other take (the client's `audioIdSeededWith` tells a
 * cell's own take from the shared imported clip that way), and carrying which
 * reference clip and which diffusion-step count produced it. Without a cellId
 * it keeps the legacy TTS→clone name.
 */
export function convertedAudioId(
  referenceAudioId: string,
  cellId: string | null,
  diffusionSteps = 10,
): string {
  const ts = Date.now()
  const rnd = crypto.randomUUID().slice(0, 8)
  if (!cellId) return `audio-clone-${ts}-${rnd}`
  const seed = cellId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
  const steps = Math.min(50, Math.max(1, Math.round(diffusionSteps)))
  return `vc-${voiceReferenceFingerprint(referenceAudioId)}-q${steps}-audio-${seed}-${ts}-${rnd}`
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

  // Resolve the source bytes: inline upload, or an existing R2 recording.
  let sourceBytes: ArrayBuffer
  let sourceType = "audio/wav"
  if (sourceEntry && typeof sourceEntry !== "string") {
    // A Blob/File upload (workers-types models the non-string entry as Blob).
    const blob = sourceEntry as Blob
    sourceBytes = await blob.arrayBuffer()
    sourceType = blob.type || sourceType
  } else if (typeof sourceAudioId === "string" && sourceAudioId) {
    // sourceAudioId is a form field (unlike /audio's URL-path ids) and lands
    // directly in an R2 key via audioObjectKey — see audio.ts's isPathSafeId
    // doc comment, which names this exact call site.
    if (!isPathSafeId(sourceAudioId)) {
      return new Response("invalid sourceAudioId", { status: 400 })
    }
    const obj = await env.SNAPSHOTS.get(audioObjectKey(env, projectId, fileId, sourceAudioId))
    if (!obj) return new Response("source audio not found", { status: 404 })
    sourceBytes = await obj.arrayBuffer()
    sourceType = obj.httpMetadata?.contentType || sourceType
  } else {
    return new Response("provide a source file or sourceAudioId", { status: 400 })
  }

  // Resolve the reference clip (project-scoped).
  const refObj = await env.SNAPSHOTS.get(voiceRefObjectKey(env, projectId, referenceAudioId))
  if (!refObj) return new Response("reference audio not found", { status: 404 })
  const refBytes = await refObj.arrayBuffer()
  const refType = refObj.httpMetadata?.contentType || "audio/wav"

  // Call Seed-VC on Modal. It expects multipart source + reference and returns
  // a wav. The shared secret travels in X-Auth-Token, never to the browser.
  const modalForm = new FormData()
  modalForm.append("source", new Blob([sourceBytes], { type: sourceType }), "source")
  modalForm.append("reference", new Blob([refBytes], { type: refType }), "reference")
  modalForm.append("diffusion_steps", String(clampSteps(form.get("diffusionSteps"))))

  let modalRes: Response
  try {
    modalRes = await fetch(env.SEED_VC_URL, {
      method: "POST",
      headers: { "X-Auth-Token": env.SEED_VC_TOKEN },
      body: modalForm,
    })
  } catch (err) {
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
  const cellIdField = form.get("cellId")
  const cellId = typeof cellIdField === "string" && cellIdField ? cellIdField : null
  const audioId = convertedAudioId(referenceAudioId, cellId, clampSteps(form.get("diffusionSteps")))
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
