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

import { audioObjectKey, r2KeyPrefix } from "./audio"
import { verifyTokenForFile, verifyTokenForProject } from "./auth"

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

  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }

  const key = voiceRefObjectKey(env, projectId, referenceAudioId)

  if (request.method === "PUT") {
    const body = await request.arrayBuffer()
    const contentType = request.headers.get("Content-Type") || "application/octet-stream"
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
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
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

  // Resolve the source bytes: inline upload, or an existing R2 recording.
  let sourceBytes: ArrayBuffer
  let sourceType = "audio/wav"
  if (sourceEntry && typeof sourceEntry !== "string") {
    // A Blob/File upload (workers-types models the non-string entry as Blob).
    const blob = sourceEntry as Blob
    sourceBytes = await blob.arrayBuffer()
    sourceType = blob.type || sourceType
  } else if (typeof sourceAudioId === "string" && sourceAudioId) {
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
    return new Response(`voice conversion upstream unreachable: ${String(err)}`, { status: 502 })
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
