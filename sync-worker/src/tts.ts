// Hosted TTS proxy: synthesize spoken audio for translated cells via Inworld
// TTS 2 Flash (AQU-1189).
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
//           tts_usage_daily (see tts-budget.ts + migration 0041). Cost goes
//           through checkAiEntitlement (AQU-2065): reserve the text's
//           characters at the dearest Inworld rate, settle at the model used.

import { audioObjectKey, isPathSafeId } from "./audio"
import { listInworldSupportedLanguages } from "./inworld-supported-languages"
import { verifyTokenForFile, verifyTokenForProject, WRITE_ROLE_LEVEL } from "./auth"
import { runTtsGuard, recordTtsUsage, estimateTtsSecondsFromText } from "./tts-budget"
import { recordCredit, runOrgCreditGuard } from "./credits"
import {
  INWORLD_DESIGN_PROMPT_MAX,
  INWORLD_DESIGN_PROMPT_MIN,
  INWORLD_MAX_TEXT_CHARS,
  designInworldVoice,
  listInworldVoices,
  parseInworldDesignPromptMode,
  clampInworldDesignSamples,
  publishInworldVoice,
  resolveInworldModelId,
  synthesizeInworldSpeech,
  INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
  type InworldTtsConfig,
} from "./inworld-tts"
import { enforceRateLimit, userRateLimitIdentifier } from "../../db/shared/rate-limit"
import {
  inworldTtsRawCents, INWORLD_VOICE_PUBLISH_CENTS, MIN_RESERVATION_CENTS,
} from "../../db/shared/audio-price-card"
import { entitleProjectAiCall, releaseQuietly, settleQuietly } from "./ai-metering"

// [Pen test] API security & data exposure (2026-09-03): runTtsGuard's daily
// seconds cap is log-only unless TTS_BUDGET_ENFORCE is set, which it isn't in
// any deployed environment — over-cap requests are logged but never blocked.
// That left this hosted synthesis call with no volumetric control: a
// scripted flood just runs. Per-user sliding-window cap, same primitive/window
// as the external Agent API's per-credential throttles — wide enough that a
// real batch-narration session (many short clips in one sitting) never trips
// it, tight enough to blunt a flood against the shared Inworld endpoint.
const TTS_MAX_PER_USER_PER_WINDOW = 200

// Voice design/publish call the paid Inworld API and mutate the shared voice
// library, so they get a contributor floor (matching audio writes) and a much
// tighter per-user throttle than synthesis.
const TTS_VOICE_MUTATION_MAX_PER_USER_PER_WINDOW = 30

async function guardVoiceMutation(
  env: TtsEnv,
  claims: { userId: number | string; role: number },
  bucket: "tts_voice_design" | "tts_voice_publish",
): Promise<Response | null> {
  if (claims.role < WRITE_ROLE_LEVEL) {
    return new Response("insufficient role", { status: 403 })
  }
  const db = env.AQUILLA_PG
  if (!db) return new Response("database not configured", { status: 500 })
  // AQU-1843: atomic, and FAIL CLOSED — these call the paid Inworld API, so a
  // limiter outage must not uncap them.
  const limit = await enforceRateLimit(db, {
    kind: bucket,
    identifier: userRateLimitIdentifier(claims.userId),
    limit: TTS_VOICE_MUTATION_MAX_PER_USER_PER_WINDOW,
    failMode: "closed",
  })
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Too many requests, slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    )
  }
  return null
}

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
  /** Stock voice when the request has no voiceId. Default Dennis. */
  INWORLD_DEFAULT_VOICE?: string
  /** Per-user daily audio-seconds cap (default 36000 = 10 h while sizing). */
  TTS_USER_DAILY_SECONDS_LIMIT?: string
  /** "true" → enforce the cap with 429; anything else → log-only. */
  TTS_BUDGET_ENFORCE?: string
  /** Platform-wide daily AI spend ceiling in USD (AQU-1869). */
  AI_DAILY_SPEND_CEILING_USD?: string
  /** Deployment profile; "test" bypasses the spend-ceiling read cache. */
  ENVIRONMENT?: string
  /** off | shadow | enforce (db/shared/ai-entitlement.ts, AQU-2061). */
  BILLING_METER_MODE?: string
  /** Postgres (Neon) handle — required for metering. */
  AQUILLA_PG?: AquillaDb
  /**
   * Org credit caps, shared with auth-worker's llm/agent rails. The pre-check
   * below is log-only unless CREDIT_ENFORCE === "true" (or the org sets
   * `credits.enforce`). See credits.ts § Org credit pre-check (AQU-1872).
   */
  CREDIT_MARKUP?: string
  CREDIT_AGENT_MARKUP?: string
  CREDIT_DAILY_CAP?: string
  CREDIT_WEEKLY_CAP?: string
  CREDIT_ENFORCE?: string
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

/**
 * POST /api/v1/voice/tts
 *
 * JSON body:
 *   { projectId, fileId, cellId?, text, voiceId?, language?,
 *     speakingRate?, deliveryMode?, audioQuality? }
 *
 * AQU-2291: Inworld instant cloning from a reference clip was removed with
 * short-clip clone voices. A stale client may still send `referenceAudioId`;
 * it is ignored (not rejected) and the clip is synthesized with `voiceId`.
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

  const { projectId, fileId, text, voiceId, language, speakingRate, deliveryMode, audioQuality } = body
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

  // Volumetric floor: unlike runTtsGuard below, this actually blocks (see
  // comment at TTS_MAX_PER_USER_PER_WINDOW).
  // AQU-1843: atomic, and FAIL CLOSED — hosted synthesis spends on the shared
  // Inworld endpoint, and runTtsGuard below is log-only in every deployed
  // environment, so this window is the only thing actually blocking a flood.
  const ttsLimit = await enforceRateLimit(db, {
    kind: "tts_synthesize",
    identifier: userRateLimitIdentifier(userId),
    limit: TTS_MAX_PER_USER_PER_WINDOW,
    failMode: "closed",
  })
  if (!ttsLimit.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Too many TTS requests, slow down." },
      { status: 429, headers: { "Retry-After": String(ttsLimit.retryAfterSeconds) } },
    )
  }

  // Pre-check the user's daily TTS budget (seconds).
  const guard = await runTtsGuard(db, userId, env)
  if (!guard.ok) {
    return Response.json(guard.body, { status: guard.status })
  }

  // The one entitlement check (AQU-2065). It runs the platform daily spend
  // ceiling (AQU-1869), which unlike runTtsGuard above is never log-only, then
  // reserves against the org's weekly allowance. The bound is the text's
  // characters at the dearest Inworld rate.
  const entitled = await entitleProjectAiCall(db, env, {
    projectId, userId, rail: "tts", provider: "inworld", houseKey: config.apiKey,
    estimateRawCents: inworldTtsRawCents(text.length),
    requestId: crypto.randomUUID(),
  })
  if (!entitled.ok) return entitled.response
  const { grant } = entitled
  const orgId = entitled.orgId ?? 0
  const keyedConfig: InworldTtsConfig = { ...config, apiKey: grant.key.apiKey }

  // Pre-check the ORG's remaining credit (AQU-1872). The per-user window above
  // is volumetric, not monetary: several users batch-narrating a Bible in one
  // org each stay under it while the org's spend runs away. This must come
  // before the paid synthesis below, so an exhausted org costs nothing.
  const creditGuard = await runOrgCreditGuard(db, env, orgId, "tts")
  if (!creditGuard.ok) {
    await releaseQuietly(grant, "tts")
    return Response.json(creditGuard.body, { status: creditGuard.status })
  }

  const inworldVoiceId = voiceId?.trim() || undefined

  let wavBytes: ArrayBuffer
  let durationSeconds: number
  try {
    const synth = await synthesizeInworldSpeech(keyedConfig, {
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
    // A timeout or 5xx may follow billed synthesis: keep the reservation held
    // for reconciliation rather than release it (ai-entitlement.ts release()).
    console.error("[tts] upstream voice request failed", err)
    return new Response("voice provider request failed", { status: 502 })
  }
  // A clip we cannot measure is charged an estimate from its text, never 0
  // (AQU-1872) — recording 0s made such a clip count toward no daily budget
  // and no credit ledger, so the whole path was silently free.
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = estimateTtsSecondsFromText(text)
    console.warn(
      `[tts] Inworld clip had no parseable duration — charging text-length estimate ` +
        `${durationSeconds.toFixed(2)}s for user ${userId} org ${orgId}`,
    )
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

  // Inworld bills input characters, so the cost is what we sent, priced at
  // the model that synthesized it (AQU-2065; it was a flat 2¢ estimate).
  const rawCostCents = inworldTtsRawCents(text.length, resolveInworldModelId(audioQuality, config.modelId))
  if (grant.recorded) {
    await settleQuietly(grant, rawCostCents, "tts")
  } else {
    // Meter off: the legacy credit ledger, as before. Never both, or the
    // platform ceiling (which sums the two ledgers) would count it twice.
    // recordCredit degrades gracefully — a ledger failure never blocks the caller.
    await recordCredit(db, orgId, userId, "tts", rawCostCents, Math.round(durationSeconds))
  }

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
    console.error("[tts] upstream voice request failed", err)
    return new Response("voice provider request failed", { status: 502 })
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
    console.error("[tts] upstream voice request failed", err)
    return new Response("voice provider request failed", { status: 502 })
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

  const blocked = await guardVoiceMutation(env, verified.claims, "tts_voice_design")
  if (blocked) return blocked

  // AQU-2065: design synthesizes one preview per sample, so it is priced as
  // that many reads of the preview text at the dearest TTS rate (the card has
  // no separate design price). Measured and bound are the same here.
  const previewChars = (body.previewText?.trim() || INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT).length
  const designCents = inworldTtsRawCents(previewChars * clampInworldDesignSamples(body.numberOfSamples))
  const entitled = await entitleProjectAiCall(env.AQUILLA_PG!, env, {
    projectId, userId: verified.claims.userId, rail: "tts", provider: "inworld", houseKey: config.apiKey,
    estimateRawCents: designCents, requestId: crypto.randomUUID(),
  })
  if (!entitled.ok) return entitled.response
  const { grant } = entitled

  try {
    const designPromptMode = parseInworldDesignPromptMode(body.designPromptMode)
    const previewVoices = await designInworldVoice({ ...config, apiKey: grant.key.apiKey }, {
      designPrompt,
      ...(body.previewText !== undefined ? { previewText: body.previewText } : {}),
      ...(body.language !== undefined ? { language: body.language } : {}),
      ...(body.numberOfSamples !== undefined ? { numberOfSamples: Number(body.numberOfSamples) } : {}),
      ...(designPromptMode ? { designPromptMode } : {}),
    })
    await settleQuietly(grant, designCents, "tts design")
    return Response.json({ previewVoices })
  } catch (err) {
    console.error("[tts] upstream voice request failed", err)
    return new Response("voice provider request failed", { status: 502 })
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

  const blocked = await guardVoiceMutation(env, verified.claims, "tts_voice_publish")
  if (blocked) return blocked

  const entitled = await entitleProjectAiCall(env.AQUILLA_PG!, env, {
    projectId, userId: verified.claims.userId, rail: "tts", provider: "inworld", houseKey: config.apiKey,
    estimateRawCents: Math.max(INWORLD_VOICE_PUBLISH_CENTS, MIN_RESERVATION_CENTS), requestId: crypto.randomUUID(),
  })
  if (!entitled.ok) return entitled.response
  const { grant } = entitled

  try {
    const publishedId = await publishInworldVoice({ ...config, apiKey: grant.key.apiKey }, {
      voiceId,
      displayName: body.displayName?.trim() || "Designed voice",
      ...(body.description !== undefined ? { description: body.description } : {}),
    })
    await settleQuietly(grant, INWORLD_VOICE_PUBLISH_CENTS, "tts publish")
    return Response.json({ voiceId: publishedId })
  } catch (err) {
    // Publish is free on the price card, so a failed one has nothing to hold.
    await releaseQuietly(grant, "tts publish")
    console.error("[tts] upstream voice request failed", err)
    return new Response("voice provider request failed", { status: 502 })
  }
}
