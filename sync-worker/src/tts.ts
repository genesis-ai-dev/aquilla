// Hosted TTS proxy: synthesize spoken audio for translated cells via Inworld
// TTS 2 Flash (AQU-1189). OmniVoice / Modal is not called from this worker.
//
// Mirrors voice-convert.ts in auth, R2 layout, and error-handling patterns.
// The browser never talks to Inworld directly — it can't hold the API key.
// This worker verifies the sync-token, pre-checks the user's daily seconds
// budget, calls Inworld, writes the WAV to R2 as a cell-audio object, records
// the actual seconds consumed, and returns an audioId the client can attach
// to the cell or pass to /voice/convert as sourceAudioId (use case 3).
//
// Auth: sync-token JWT scoped to (projectId, fileId) via verifyTokenForFile,
//       identical to /audio and /voice/convert.
//
// Metering: audio seconds, per-user with org_id attribution, in
//           tts_usage_daily (see tts-budget.ts + migration 0041).

import { audioObjectKey, isPathSafeId, r2KeyPrefix } from "./audio"
import { listInworldSupportedLanguages } from "./inworld-supported-languages"
import { verifyTokenForFile, verifyTokenForProject } from "./auth"
import { runTtsGuard, recordTtsUsage } from "./tts-budget"
import { recordCredit } from "./credits"
import {
  INWORLD_DESIGN_PROMPT_MAX,
  INWORLD_DESIGN_PROMPT_MIN,
  INWORLD_MAX_TEXT_CHARS,
  cloneInworldVoice,
  designInworldVoice,
  listInworldVoices,
  parseInworldDesignPromptMode,
  publishInworldVoice,
  synthesizeInworldSpeech,
  type InworldTtsConfig,
} from "./inworld-tts"

export interface TtsEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  /**
   * Inworld Portal API key (base64 key:secret). Worker sends
   * `Authorization: Basic $INWORLD_API_KEY`. See docs/INWORLD-TTS.md.
   */
  INWORLD_API_KEY?: string
  /** Override Inworld API origin. Default https://api.inworld.ai */
  INWORLD_API_BASE?: string
  /** Override model id when audioQuality is omitted. Default inworld-tts-2 */
  INWORLD_TTS_MODEL?: string
  /** Stock voice when the request has no voiceId and no clone. Default Dennis. */
  INWORLD_DEFAULT_VOICE?: string
  /** Per-user daily audio-seconds cap (default 36000 = 10 h while sizing). */
  TTS_USER_DAILY_SECONDS_LIMIT?: string
  /** "true" → enforce the cap with 429; anything else → log-only. */
  TTS_BUDGET_ENFORCE?: string
  /** Postgres (Neon) handle — required for metering. */
  AQUILLA_PG?: AquillaDb
  /**
   * Flat per-call TTS cost estimate in cents (amortised GPU cold-start, etc.).
   * Default: 2 (i.e. 2¢ per synthesis call).
   * Spec: docs/superpowers/specs/2026-06-13-org-credits-cost-model.md § Config
   */
  TTS_COST_CENTS_PER_CALL?: string
  /**
   * Additional cost per audio-second in cents.
   * Default: 0 (per-call estimate is the primary signal until we have GPU billing).
   */
  TTS_COST_PER_AUDIO_SEC_CENTS?: string
}

const TTS_PATH = "/api/v1/voice/tts"
const TTS_VOICES_PATH = "/api/v1/voice/tts/voices"
const TTS_SUPPORTED_LANGUAGES_PATH = "/api/v1/voice/tts/supported-languages"
const TTS_DESIGN_PATH = "/api/v1/voice/tts/design"
const TTS_PUBLISH_PATH = "/api/v1/voice/tts/publish"

function inworldConfig(env: TtsEnv): InworldTtsConfig | null {
  const apiKey = env.INWORLD_API_KEY?.trim()
  if (!apiKey) return null
  return {
    apiKey,
    ...(env.INWORLD_API_BASE ? { apiBase: env.INWORLD_API_BASE } : {}),
    ...(env.INWORLD_TTS_MODEL ? { modelId: env.INWORLD_TTS_MODEL } : {}),
    ...(env.INWORLD_DEFAULT_VOICE ? { defaultVoiceId: env.INWORLD_DEFAULT_VOICE } : {}),
  }
}

function inworldCloneCacheKey(env: TtsEnv, projectId: string, referenceAudioId: string): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/voices/${referenceAudioId}.inworld.json`
}

/**
 * POST /api/v1/voice/tts
 *
 * JSON body:
 *   { projectId, fileId, cellId?, text, voiceId?, referenceAudioId?, language?,
 *     speakingRate?, deliveryMode?, audioQuality? }
 *
 * Returns { audioId, durationSeconds } on success.
 * Returns null when the path/method doesn't match (dispatcher falls through).
 */
export async function handleTtsRequest(
  request: Request,
  env: TtsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname === TTS_VOICES_PATH) {
    return handleListTtsVoices(request, env, url)
  }
  if (url.pathname === TTS_SUPPORTED_LANGUAGES_PATH) {
    return handleListSupportedLanguages(request, env, url)
  }
  if (url.pathname === TTS_DESIGN_PATH) {
    return handleDesignTtsVoice(request, env)
  }
  if (url.pathname === TTS_PUBLISH_PATH) {
    return handlePublishTtsVoice(request, env)
  }
  if (url.pathname !== TTS_PATH) return null
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }
  const config = inworldConfig(env)
  if (!config) {
    return new Response("TTS not configured", { status: 503 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("database not available", { status: 503 })
  }

  // Parse body.
  let body: {
    projectId?: string
    fileId?: string
    cellId?: string
    text?: string
    voiceId?: string
    referenceAudioId?: string
    language?: string
    speakingRate?: unknown
    deliveryMode?: unknown
    audioQuality?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return new Response("expected JSON body", { status: 400 })
  }

  const { projectId, fileId, text, voiceId, referenceAudioId, language, speakingRate, deliveryMode, audioQuality } = body
  if (!projectId || !fileId || !text) {
    return new Response("missing projectId, fileId, or text", { status: 400 })
  }
  // projectId/fileId come straight from the JSON body (unlike /audio, whose
  // ids are URL-path segments matched by `[^/]+`) and land directly in an R2
  // key below, so reject anything that could act as a path separator there.
  if (!isPathSafeId(projectId) || !isPathSafeId(fileId)) {
    return new Response("invalid projectId or fileId", { status: 400 })
  }
  // Bound text size — Inworld's sync synthesize endpoint caps at 2000 chars.
  if (text.length > INWORLD_MAX_TEXT_CHARS) {
    return new Response(`text too long (max ${INWORLD_MAX_TEXT_CHARS} chars)`, { status: 400 })
  }
  // Sanitize the reference id before it becomes part of an R2 key.
  if (referenceAudioId !== undefined && !/^[\w.-]+$/.test(referenceAudioId)) {
    return new Response("invalid referenceAudioId", { status: 400 })
  }
  if (voiceId !== undefined && (voiceId.length > 200 || /[\r\n]/.test(voiceId))) {
    return new Response("invalid voiceId", { status: 400 })
  }

  // Auth: sync-token scoped to (projectId, fileId), same as /audio.
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }
  // verifyTokenForFile checks fileId; also verify the projectId from claims.
  if (verified.claims.projectId !== projectId) {
    return new Response("token scoped to different project", { status: 403 })
  }

  const userId = verified.claims.userId

  // Resolve org_id from the project row. Mirrors export-floor.ts pattern.
  const db = env.AQUILLA_PG
  const projectRow = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  const orgId = projectRow?.org_id ?? 0

  // Pre-check the user's daily TTS budget (seconds).
  const guard = await runTtsGuard(db, userId, env)
  if (!guard.ok) {
    return Response.json(guard.body, { status: guard.status })
  }

  let inworldVoiceId = voiceId?.trim() || undefined

  // Optionally resolve a reference clip and clone it once (cached in R2).
  // A clone always wins over a stock voiceId — that's the zero-shot path.
  if (referenceAudioId) {
    const cacheKey = inworldCloneCacheKey(env, projectId, referenceAudioId)
    let clonedVoiceId: string | undefined
    const cached = await env.SNAPSHOTS.get(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(await cached.text()) as { voiceId?: string }
        if (parsed.voiceId) clonedVoiceId = parsed.voiceId
      } catch {
        // Corrupt sidecar — re-clone below.
      }
    }
    if (!clonedVoiceId) {
      const refKey = `${r2KeyPrefix(env)}projects/${projectId}/voices/${referenceAudioId}`
      const refObj = await env.SNAPSHOTS.get(refKey)
      if (!refObj) return new Response("reference audio not found", { status: 404 })
      const referenceBytes = await refObj.arrayBuffer()
      try {
        clonedVoiceId = await cloneInworldVoice(config, {
          displayName: referenceAudioId,
          audioBytes: referenceBytes,
          language,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return new Response(message, { status: 502 })
      }
      await env.SNAPSHOTS.put(cacheKey, JSON.stringify({ voiceId: clonedVoiceId }), {
        httpMetadata: { contentType: "application/json" },
      })
    }
    inworldVoiceId = clonedVoiceId
  }

  let wavBytes: ArrayBuffer
  let durationSeconds: number
  try {
    const synth = await synthesizeInworldSpeech(config, {
      text,
      voiceId: inworldVoiceId,
      language,
      speakingRate,
      deliveryMode,
      audioQuality,
    })
    wavBytes = synth.wavBytes
    durationSeconds = Number.isFinite(synth.durationSeconds) ? Math.max(0, synth.durationSeconds) : 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(message, { status: 502 })
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    console.warn(
      `[tts] Inworld clip had no parseable duration — recording 0s for user ${userId} org ${orgId}`,
    )
    durationSeconds = 0
  }

  // Write WAV to R2 as a cell-audio object (same layout as voice-convert).
  const audioId = `audio-tts-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const ext = "wav"
  const objectName = `${audioId}.${ext}`
  await env.SNAPSHOTS.put(audioObjectKey(env, projectId, fileId, objectName), wavBytes, {
    httpMetadata: { contentType: "audio/wav" },
  })

  // Post-record actual seconds. Mirrors ai-budget.ts: counter failure never
  // blocks a successful synthesis — recordTtsUsage degrades gracefully.
  await recordTtsUsage(db, userId, orgId, durationSeconds)

  // Record TTS raw compute cost into the cross-rail credit ledger.
  // Formula: flat per-call cost + optional per-second cost (both configurable).
  // Spec: docs/superpowers/specs/2026-06-13-org-credits-cost-model.md § WS-SYNC-CREDITS
  // recordCredit degrades gracefully — a ledger failure never blocks the caller.
  const costPerCall = Number(env.TTS_COST_CENTS_PER_CALL ?? 2)
  const costPerSec = Number(env.TTS_COST_PER_AUDIO_SEC_CENTS ?? 0)
  const rawCostCents =
    (Number.isFinite(costPerCall) ? Math.max(0, costPerCall) : 2) +
    durationSeconds * (Number.isFinite(costPerSec) ? Math.max(0, costPerSec) : 0)
  await recordCredit(db, orgId, userId, "tts", rawCostCents, Math.round(durationSeconds))

  return Response.json({
    audioId,
    durationSeconds,
    objectName,
    url: `frontier-audio://${objectName}`,
  })
}

/**
 * GET /api/v1/voice/tts/supported-languages?projectId=
 *
 * Inworld Voice Design catalog (family + accent). Auth is a project-scoped
 * sync token. The browser never calls Inworld directly.
 */
async function handleListSupportedLanguages(
  request: Request,
  env: TtsEnv,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 })
  }
  const config = inworldConfig(env)
  if (!config) {
    return new Response("TTS not configured", { status: 503 })
  }
  const projectId = url.searchParams.get("projectId")?.trim() ?? ""
  if (!projectId || !isPathSafeId(projectId)) {
    return new Response("missing or invalid projectId", { status: 400 })
  }
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }

  try {
    const languages = await listInworldSupportedLanguages(config)
    return Response.json({ languages })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(message, { status: 502 })
  }
}

/**
 * GET /api/v1/voice/tts/voices?projectId=&language=en&language=es
 *     GET /api/v1/voice/tts/voices?projectId=&all=1
 *
 * Returns Inworld SYSTEM voices whose primary language matches any of the
 * project's target-language lanes. `all=1` skips the language filter.
 * Auth is a project-scoped sync token.
 */
async function handleListTtsVoices(
  request: Request,
  env: TtsEnv,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 })
  }
  const config = inworldConfig(env)
  if (!config) {
    return new Response("TTS not configured", { status: 503 })
  }
  const projectId = url.searchParams.get("projectId")?.trim() ?? ""
  if (!projectId || !isPathSafeId(projectId)) {
    return new Response("missing or invalid projectId", { status: 400 })
  }
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }

  const languages = [
    ...url.searchParams.getAll("language"),
    ...(url.searchParams.get("languages")?.split(",") ?? []),
  ].map((v) => v.trim()).filter(Boolean)
  const allSystem = url.searchParams.get("all") === "1"

  try {
    const voices = await listInworldVoices(config, languages, { allSystem })
    return Response.json({ voices })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(message, { status: 502 })
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
}

/**
 * POST /api/v1/voice/tts/design
 *
 * JSON body: { projectId, designPrompt, designPromptMode?, previewText?, language?, numberOfSamples? }
 * Returns { previewVoices: [{ voiceId, previewText, previewAudio }] }.
 * Preview audio is base64 — not written to R2.
 */
async function handleDesignTtsVoice(request: Request, env: TtsEnv): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }
  const config = inworldConfig(env)
  if (!config) {
    return new Response("TTS not configured", { status: 503 })
  }

  let body: {
    projectId?: string
    designPrompt?: string
    designPromptMode?: string
    previewText?: string
    language?: string
    numberOfSamples?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return new Response("expected JSON body", { status: 400 })
  }

  const projectId = body.projectId?.trim() ?? ""
  if (!projectId || !isPathSafeId(projectId)) {
    return new Response("missing or invalid projectId", { status: 400 })
  }
  const designPrompt = body.designPrompt?.trim() ?? ""
  if (designPrompt.length < INWORLD_DESIGN_PROMPT_MIN || designPrompt.length > INWORLD_DESIGN_PROMPT_MAX) {
    return new Response(
      `design prompt must be ${INWORLD_DESIGN_PROMPT_MIN}–${INWORLD_DESIGN_PROMPT_MAX} characters`,
      { status: 400 },
    )
  }

  const verified = await verifyTokenForProject(bearerToken(request), projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }

  try {
    const designPromptMode = parseInworldDesignPromptMode(body.designPromptMode)
    const previewVoices = await designInworldVoice(config, {
      designPrompt,
      ...(body.previewText !== undefined ? { previewText: body.previewText } : {}),
      ...(body.language !== undefined ? { language: body.language } : {}),
      ...(body.numberOfSamples !== undefined ? { numberOfSamples: Number(body.numberOfSamples) } : {}),
      ...(designPromptMode ? { designPromptMode } : {}),
    })
    return Response.json({ previewVoices })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(message, { status: 502 })
  }
}

/**
 * POST /api/v1/voice/tts/publish
 *
 * JSON body: { projectId, voiceId, displayName?, description? }
 * Returns { voiceId } of the published library voice.
 */
async function handlePublishTtsVoice(request: Request, env: TtsEnv): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }
  const config = inworldConfig(env)
  if (!config) {
    return new Response("TTS not configured", { status: 503 })
  }

  let body: {
    projectId?: string
    voiceId?: string
    displayName?: string
    description?: string
  }
  try {
    body = await request.json()
  } catch {
    return new Response("expected JSON body", { status: 400 })
  }

  const projectId = body.projectId?.trim() ?? ""
  const voiceId = body.voiceId?.trim() ?? ""
  if (!projectId || !isPathSafeId(projectId)) {
    return new Response("missing or invalid projectId", { status: 400 })
  }
  if (!voiceId || voiceId.length > 200 || /[\r\n/?#]/.test(voiceId)) {
    return new Response("invalid voiceId", { status: 400 })
  }

  const verified = await verifyTokenForProject(bearerToken(request), projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status })
  }

  try {
    const publishedId = await publishInworldVoice(config, {
      voiceId,
      displayName: body.displayName?.trim() || "Designed voice",
      ...(body.description !== undefined ? { description: body.description } : {}),
    })
    return Response.json({ voiceId: publishedId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(message, { status: 502 })
  }
}
