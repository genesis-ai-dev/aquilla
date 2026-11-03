// ElevenLabs as a voice engine, bring-your-own-key (AQU-2299).
//
// The browser cannot call ElevenLabs with the project's R2 in reach, and must
// not mint its own storage keys, so every call goes through these routes. The
// user's own ElevenLabs key rides each request in `X-ElevenLabs-Key`; this
// worker forwards it as `xi-api-key` (elevenlabs-api.ts) and never stores or
// logs it. Because the user pays ElevenLabs directly there is no Aquilla credit
// metering here — only the per-user volumetric throttles, like /voice/tts.
//
//   GET  /api/v1/elevenlabs/user?projectId=          tier + character quota
//   GET  /api/v1/elevenlabs/voices?projectId=&search=&category=&pageToken=
//   GET  /api/v1/elevenlabs/models?projectId=        curated TTS models
//   POST /api/v1/elevenlabs/tts                      JSON; stores mp3 + returns the
//                                                    /voice/tts contract, or with
//                                                    `preview: true` returns the
//                                                    audio itself (no R2 write)
//   POST /api/v1/elevenlabs/sts                      multipart; a converted take
//                                                    with /voice/convert's contract
//   POST /api/v1/elevenlabs/clone                    JSON; Instant Voice Clone from
//                                                    the project's reference clips
//
// Auth mirrors the routes it stands beside: reads take a project sync token;
// tts a file token (as /voice/tts); sts a file token at the contributor floor
// (as /voice/convert); clone a project token at the maintainer floor with the
// organization's consent confirmation (as /voice/custom), recorded in R2.

import { audioObjectKey, isPathSafeId, r2KeyPrefix } from "./audio"
import { verifyTokenForFile, verifyTokenForProject, WRITE_ROLE_LEVEL, type SyncTokenClaims } from "./auth"
import { enforceRateLimit, userRateLimitIdentifier } from "../../db/shared/rate-limit"
import {
  CUSTOM_VOICE_CONSENT_STATEMENT,
  CUSTOM_VOICE_CONSENT_VERSION,
  CUSTOM_VOICE_ROLE_LEVEL,
} from "./custom-voice"
import {
  MAX_VOICE_CLIP_BYTES,
  MAX_VOICE_CONVERT_REQUEST_BYTES,
  voiceRefObjectKey,
  voiceReferenceFingerprint,
} from "./voice-convert"
import {
  ELEVENLABS_DEFAULT_TTS_MODEL,
  ELEVENLABS_MAX_TEXT_CHARS,
  ELEVENLABS_STS_MODEL,
  ElevenLabsUpstreamError,
  cloneElevenLabsVoice,
  convertSpeechElevenLabs,
  elevenLabsBaseUrl,
  elevenLabsErrorResponse,
  getElevenLabsAccount,
  isElevenLabsModelId,
  isElevenLabsVoiceCategory,
  isElevenLabsVoiceId,
  listElevenLabsModels,
  listElevenLabsVoices,
  mp3DurationSeconds,
  parseVoiceSettings,
  synthesizeElevenLabs,
  type ElevenLabsConfig,
} from "./elevenlabs-api"

export interface ElevenLabsEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  AQUILLA_PG?: AquillaDb
  /** Upstream origin. Unset → https://api.elevenlabs.io; `pnpm dev` points it
   *  at scripts/mock-elevenlabs.ts. */
  ELEVENLABS_BASE_URL?: string
}

/** The header the SPA sends the user's key in. Allowed by cors.ts. */
export const ELEVENLABS_KEY_HEADER = "X-ElevenLabs-Key"

// Per-user sliding windows (15 min, the shared limiter). The user pays
// ElevenLabs, so these only blunt a runaway loop: synthesis matches /voice/tts,
// conversion /voice/convert, cloning sits with the other voice mutations.
export const ELEVENLABS_TTS_MAX_PER_WINDOW = 200
export const ELEVENLABS_STS_MAX_PER_WINDOW = 60
export const ELEVENLABS_CLONE_MAX_PER_WINDOW = 10

/** A preview is one sample line, never a chapter. */
export const ELEVENLABS_PREVIEW_MAX_CHARS = 300
/** ElevenLabs takes up to 25 samples per Instant Voice Clone. */
export const ELEVENLABS_CLONE_MAX_CLIPS = 25
/** Every sample is buffered for the one upstream multipart; bound the total. */
export const ELEVENLABS_CLONE_MAX_TOTAL_BYTES = 40 * 1024 * 1024

const BASE = "/api/v1/elevenlabs/"

/** Conversion fingerprint key for an ElevenLabs voice. Mirrored by
 *  `voiceConversionKey` in src/lib/audio/change-voice.ts. */
export function elevenLabsVoiceKey(voiceId: string): string {
  return `elevenlabs:${voiceId}`
}

/** R2 key of a cloned voice's consent audit record. */
export function elevenLabsConsentKey(env: Pick<ElevenLabsEnv, "R2_KEY_PREFIX">, projectId: string, voiceId: string): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/voices/elevenlabs/${voiceId}/consent.json`
}

const bearer = (request: Request) => {
  const header = request.headers.get("Authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
}

const fail = (status: number, error: string, message: string) => Response.json({ error, message }, { status })

/** The caller's key, or the response explaining why there is none. */
function keyFrom(request: Request, env: ElevenLabsEnv): ElevenLabsConfig | Response {
  const key = request.headers.get(ELEVENLABS_KEY_HEADER)?.trim() ?? ""
  if (!key) return fail(400, "elevenlabs_key_missing", "Connect an ElevenLabs API key first")
  // Anything outside printable ASCII (or absurdly long) cannot be a real key,
  // and must not be forwarded into a header.
  if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
    return fail(401, "elevenlabs_invalid_key", "ElevenLabs rejected the API key")
  }
  return { apiKey: key, baseUrl: elevenLabsBaseUrl(env) }
}

async function throttle(
  env: ElevenLabsEnv,
  claims: SyncTokenClaims,
  kind: string,
  limit: number,
): Promise<Response | null> {
  const db = env.AQUILLA_PG
  if (!db) return new Response("database not configured", { status: 500 })
  // Fail OPEN: unlike the house-key routes, a limiter outage spends nobody's
  // money but the caller's own, and refusing them would take the engine down.
  const decision = await enforceRateLimit(db, {
    kind,
    identifier: userRateLimitIdentifier(claims.userId),
    limit,
    failMode: "open",
  })
  if (decision.allowed) return null
  return Response.json(
    { error: "rate_limited", message: "Too many ElevenLabs requests, slow down." },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  )
}

async function upstreamCall(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ElevenLabsUpstreamError) return elevenLabsErrorResponse(err)
    console.error("[elevenlabs] unexpected failure:", err instanceof Error ? err.name : "unknown")
    return fail(502, "elevenlabs_failed", "ElevenLabs request failed")
  }
}

export async function handleElevenLabsRequest(request: Request, env: ElevenLabsEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(BASE)) return null
  const route = url.pathname.slice(BASE.length)
  switch (route) {
    case "user":
    case "voices":
    case "models":
      return handleRead(request, env, url, route)
    case "tts":
      return handleTts(request, env)
    case "sts":
      return handleSts(request, env)
    case "clone":
      return handleClone(request, env)
    default:
      return new Response("not found", { status: 404 })
  }
}

async function handleRead(
  request: Request,
  env: ElevenLabsEnv,
  url: URL,
  route: "user" | "voices" | "models",
): Promise<Response> {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 })
  const projectId = url.searchParams.get("projectId")?.trim() ?? ""
  if (!projectId || !isPathSafeId(projectId)) return new Response("missing or invalid projectId", { status: 400 })
  const verified = await verifyTokenForProject(bearer(request), projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return new Response(verified.reason, { status: verified.status })
  const config = keyFrom(request, env)
  if (config instanceof Response) return config

  return upstreamCall(async () => {
    if (route === "user") return Response.json(await getElevenLabsAccount(config))
    if (route === "models") return Response.json({ models: await listElevenLabsModels(config) })
    const category = url.searchParams.get("category") ?? undefined
    const page = await listElevenLabsVoices(config, {
      search: url.searchParams.get("search")?.trim().slice(0, 100) || undefined,
      category: isElevenLabsVoiceCategory(category) ? category : undefined,
      pageToken: url.searchParams.get("pageToken")?.slice(0, 500) || undefined,
    })
    return Response.json(page)
  })
}

interface TtsBody {
  projectId?: unknown
  fileId?: unknown
  cellId?: unknown
  text?: unknown
  voiceId?: unknown
  modelId?: unknown
  voiceSettings?: unknown
  languageCode?: unknown
  preview?: unknown
}

/**
 * POST /api/v1/elevenlabs/tts
 *   { projectId, fileId, cellId?, text, voiceId, modelId?, voiceSettings?, languageCode?, preview? }
 *
 * Stored: { audioId, durationSeconds, objectName, url } — the /voice/tts
 * contract, with an `.mp3` object. Preview: the mp3 bytes, nothing written.
 */
async function handleTts(request: Request, env: ElevenLabsEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  let body: TtsBody
  try {
    body = (await request.json()) as TtsBody
  } catch {
    return new Response("expected JSON body", { status: 400 })
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : ""
  const fileId = typeof body.fileId === "string" ? body.fileId : ""
  const text = typeof body.text === "string" ? body.text.trim() : ""
  const preview = body.preview === true
  if (!projectId || !fileId || !text) return new Response("missing projectId, fileId, or text", { status: 400 })
  if (!isPathSafeId(projectId) || !isPathSafeId(fileId)) return new Response("invalid projectId or fileId", { status: 400 })
  const maxChars = preview ? ELEVENLABS_PREVIEW_MAX_CHARS : ELEVENLABS_MAX_TEXT_CHARS
  if (text.length > maxChars) return new Response(`text too long (max ${maxChars} chars)`, { status: 400 })
  if (!isElevenLabsVoiceId(body.voiceId)) return new Response("invalid voiceId", { status: 400 })
  const modelId = body.modelId === undefined ? ELEVENLABS_DEFAULT_TTS_MODEL : body.modelId
  if (!isElevenLabsModelId(modelId)) return new Response("invalid modelId", { status: 400 })
  const languageCode = typeof body.languageCode === "string" && /^[a-z]{2,3}$/.test(body.languageCode)
    ? body.languageCode
    : undefined

  const verified = await verifyTokenForFile(bearer(request), fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return new Response(verified.reason, { status: verified.status })
  if (verified.claims.projectId !== projectId) return new Response("token scoped to different project", { status: 403 })
  const config = keyFrom(request, env)
  if (config instanceof Response) return config
  const limited = await throttle(env, verified.claims, "elevenlabs_tts", ELEVENLABS_TTS_MAX_PER_WINDOW)
  if (limited) return limited

  const voiceId = body.voiceId
  return upstreamCall(async () => {
    const mp3 = await synthesizeElevenLabs(config, {
      voiceId,
      text,
      modelId,
      voiceSettings: parseVoiceSettings(body.voiceSettings),
      ...(languageCode ? { languageCode } : {}),
    })
    if (preview) {
      return new Response(mp3, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      })
    }
    const audioId = `audio-tts-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const objectName = `${audioId}.mp3`
    await env.SNAPSHOTS.put(audioObjectKey(env, projectId, fileId, objectName), mp3, {
      httpMetadata: { contentType: "audio/mpeg" },
    })
    return Response.json({
      audioId,
      durationSeconds: mp3DurationSeconds(mp3.byteLength),
      objectName,
      url: `frontier-audio://${objectName}`,
    })
  })
}

/** Same naming as voice-convert's `convertedAudioId`, so the client's take
 *  lineage (vc- prefix + fingerprint + cell seed) reads it unchanged. */
function convertedObjectId(voiceId: string, cellId: string): string {
  const seed = cellId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
  return `vc-${voiceReferenceFingerprint(elevenLabsVoiceKey(voiceId))}-audio-${seed}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * POST /api/v1/elevenlabs/sts (multipart/form-data)
 *   fields: projectId, fileId, cellId, voiceId, [modelId], [voiceSettings JSON], [sourceAudioId]
 *   files:  [source] — required unless sourceAudioId is given
 *
 * Returns { ok, audioId, ext: "mp3", objectName, url, bytes } — /voice/convert's contract.
 */
async function handleSts(request: Request, env: ElevenLabsEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  const declared = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(declared) && declared > MAX_VOICE_CONVERT_REQUEST_BYTES) {
    return new Response("source clip too large", { status: 413 })
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return new Response("expected multipart/form-data", { status: 400 })
  }
  const field = (name: string) => {
    const v = form.get(name)
    return typeof v === "string" ? v : ""
  }
  const projectId = field("projectId")
  const fileId = field("fileId")
  const cellId = field("cellId")
  const voiceId = field("voiceId")
  const modelId = field("modelId") || ELEVENLABS_STS_MODEL
  if (!projectId || !fileId || !cellId || !voiceId) {
    return new Response("missing projectId, fileId, cellId, or voiceId", { status: 400 })
  }
  if (!isPathSafeId(projectId) || !isPathSafeId(fileId)) return new Response("invalid projectId or fileId", { status: 400 })
  if (!isElevenLabsVoiceId(voiceId)) return new Response("invalid voiceId", { status: 400 })
  if (!isElevenLabsModelId(modelId)) return new Response("invalid modelId", { status: 400 })
  let voiceSettings: unknown = null
  if (field("voiceSettings")) {
    try {
      voiceSettings = JSON.parse(field("voiceSettings"))
    } catch {
      return new Response("invalid voiceSettings", { status: 400 })
    }
  }

  const verified = await verifyTokenForFile(bearer(request), fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return new Response(verified.reason, { status: verified.status })
  if (verified.claims.projectId !== projectId) return new Response("token scoped to different project", { status: 403 })
  // Same floor as cell.audio.attach and /voice/convert: the result is a new take.
  if (verified.claims.role < WRITE_ROLE_LEVEL) return new Response("insufficient role", { status: 403 })
  const config = keyFrom(request, env)
  if (config instanceof Response) return config

  let source: Blob
  const inline = form.get("source")
  const sourceAudioId = field("sourceAudioId")
  if (inline && typeof inline !== "string") {
    source = inline as Blob
  } else if (sourceAudioId) {
    if (!isPathSafeId(sourceAudioId)) return new Response("invalid sourceAudioId", { status: 400 })
    const obj = await env.SNAPSHOTS.get(audioObjectKey(env, projectId, fileId, sourceAudioId))
    if (!obj) return new Response("source audio not found", { status: 404 })
    if (obj.size > MAX_VOICE_CLIP_BYTES) return new Response("stored source recording too large", { status: 413 })
    source = await obj.blob()
  } else {
    return new Response("provide a source file or sourceAudioId", { status: 400 })
  }
  if (source.size > MAX_VOICE_CLIP_BYTES) return new Response("source clip too large", { status: 413 })

  const limited = await throttle(env, verified.claims, "elevenlabs_sts", ELEVENLABS_STS_MAX_PER_WINDOW)
  if (limited) return limited

  return upstreamCall(async () => {
    const mp3 = await convertSpeechElevenLabs(config, {
      voiceId,
      audio: source,
      modelId,
      voiceSettings: parseVoiceSettings(voiceSettings),
    })
    const audioId = convertedObjectId(voiceId, cellId)
    const objectName = `${audioId}.mp3`
    await env.SNAPSHOTS.put(audioObjectKey(env, projectId, fileId, objectName), mp3, {
      httpMetadata: { contentType: "audio/mpeg" },
    })
    return Response.json({
      ok: true,
      audioId,
      ext: "mp3",
      objectName,
      url: `frontier-audio://${objectName}`,
      bytes: mp3.byteLength,
    })
  })
}

export interface ElevenLabsConsentRecord {
  provider: "elevenlabs"
  voiceId: string
  projectId: string
  voiceName: string
  attestedByUserId: number | string
  attestedAt: string
  statementVersion: string
  statement: string
  referenceAudioIds: string[]
}

interface CloneBody {
  projectId?: unknown
  name?: unknown
  description?: unknown
  labels?: unknown
  referenceAudioIds?: unknown
  removeBackgroundNoise?: unknown
  consent?: { confirmed?: unknown; statementVersion?: unknown }
}

/**
 * POST /api/v1/elevenlabs/clone
 *   { projectId, name, referenceAudioIds[], removeBackgroundNoise?, description?,
 *     labels?, consent: { confirmed: true, statementVersion } }
 *
 * The samples are this project's reference clips (uploaded first through
 * /api/v1/voice/reference). Returns { voiceId, requiresVerification,
 * attestedAt, statementVersion }.
 */
async function handleClone(request: Request, env: ElevenLabsEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  let body: CloneBody
  try {
    body = (await request.json()) as CloneBody
  } catch {
    return new Response("expected JSON body", { status: 400 })
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : ""
  if (!projectId || !isPathSafeId(projectId)) return new Response("missing or invalid projectId", { status: 400 })
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : ""
  if (!name) return new Response("missing name", { status: 400 })
  const refs = Array.isArray(body.referenceAudioIds)
    ? body.referenceAudioIds.filter((r): r is string => typeof r === "string")
    : []
  if (refs.length === 0 || refs.length > ELEVENLABS_CLONE_MAX_CLIPS || refs.some((r) => !isPathSafeId(r))) {
    return new Response(`send 1-${ELEVENLABS_CLONE_MAX_CLIPS} referenceAudioIds`, { status: 400 })
  }

  const verified = await verifyTokenForProject(bearer(request), projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return new Response(verified.reason, { status: verified.status })
  // A real person's voice is a project-level decision — /voice/custom's floor.
  if (verified.claims.role < CUSTOM_VOICE_ROLE_LEVEL) {
    return new Response("cloning a voice requires maintainer role", { status: 403 })
  }
  if (body.consent?.confirmed !== true || body.consent.statementVersion !== CUSTOM_VOICE_CONSENT_VERSION) {
    return Response.json(
      { error: "consent_required", statementVersion: CUSTOM_VOICE_CONSENT_VERSION, statement: CUSTOM_VOICE_CONSENT_STATEMENT },
      { status: 422 },
    )
  }
  const config = keyFrom(request, env)
  if (config instanceof Response) return config
  const limited = await throttle(env, verified.claims, "elevenlabs_clone", ELEVENLABS_CLONE_MAX_PER_WINDOW)
  if (limited) return limited

  const files: { blob: Blob; name: string }[] = []
  let total = 0
  for (const ref of refs) {
    const obj = await env.SNAPSHOTS.get(voiceRefObjectKey(env, projectId, ref))
    if (!obj) return new Response(`recording not found: ${ref}`, { status: 404 })
    total += obj.size
    if (obj.size > MAX_VOICE_CLIP_BYTES || total > ELEVENLABS_CLONE_MAX_TOTAL_BYTES) {
      return new Response("recordings too large to clone in one request", { status: 413 })
    }
    files.push({ blob: await obj.blob(), name: ref })
  }

  const labels: Record<string, string> = {}
  if (body.labels && typeof body.labels === "object") {
    // The four keys ElevenLabs accepts on a voice (IVC create docs).
    for (const key of ["language", "accent", "gender", "age"]) {
      const v = (body.labels as Record<string, unknown>)[key]
      if (typeof v === "string" && v.trim()) labels[key] = v.trim().slice(0, 40)
    }
  }
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : ""

  return upstreamCall(async () => {
    const cloned = await cloneElevenLabsVoice(config, {
      name,
      files,
      removeBackgroundNoise: body.removeBackgroundNoise === true,
      ...(description ? { description } : {}),
      labels,
    })
    const record: ElevenLabsConsentRecord = {
      provider: "elevenlabs",
      voiceId: cloned.voiceId,
      projectId,
      voiceName: name,
      attestedByUserId: verified.claims.userId,
      attestedAt: new Date().toISOString(),
      statementVersion: CUSTOM_VOICE_CONSENT_VERSION,
      statement: CUSTOM_VOICE_CONSENT_STATEMENT,
      referenceAudioIds: refs,
    }
    if (isPathSafeId(cloned.voiceId)) {
      await env.SNAPSHOTS.put(elevenLabsConsentKey(env, projectId, cloned.voiceId), JSON.stringify(record, null, 2), {
        httpMetadata: { contentType: "application/json" },
      })
    }
    return Response.json({
      voiceId: cloned.voiceId,
      requiresVerification: cloned.requiresVerification,
      attestedAt: record.attestedAt,
      statementVersion: record.statementVersion,
    })
  })
}
