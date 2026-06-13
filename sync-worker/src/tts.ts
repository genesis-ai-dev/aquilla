// OmniVoice TTS proxy: synthesize spoken audio for translated cells.
//
// Mirrors voice-convert.ts in auth, R2 layout, and error-handling patterns.
// The browser never talks to Modal directly — it can't hold the Modal secret.
// This worker verifies the sync-token, pre-checks the user's daily seconds
// budget, calls the OmniVoice Modal endpoint, writes the WAV to R2 as a
// cell-audio object, records the actual seconds consumed, and returns an
// audioId the client can attach to the cell or pass to /voice/convert as
// sourceAudioId (use case 3).
//
// Auth: sync-token JWT scoped to (projectId, fileId) via verifyTokenForFile,
//       identical to /audio and /voice/convert.
//
// Metering: audio seconds, per-user with org_id attribution, in
//           tts_usage_daily (see tts-budget.ts + migration 0041).

import { audioObjectKey, r2KeyPrefix } from "./audio"
import { verifyTokenForFile } from "./auth"
import { runTtsGuard, recordTtsUsage } from "./tts-budget"
import { recordCredit } from "./credits"

export interface TtsEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  /** OmniVoice Modal endpoint, e.g. https://<acct>--omnivoice-web.modal.run */
  OMNIVOICE_URL?: string
  /** Shared secret matching the Modal `omnivoice-auth` secret's OMNIVOICE_TOKEN. */
  OMNIVOICE_TOKEN?: string
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

/**
 * POST /api/v1/voice/tts
 *
 * JSON body:
 *   { projectId, fileId, cellId?, text, referenceAudioId?, language? }
 *
 * Returns { audioId, durationSeconds } on success.
 * Returns null when the path/method doesn't match (dispatcher falls through).
 */
export async function handleTtsRequest(
  request: Request,
  env: TtsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== TTS_PATH) return null
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }
  if (!env.OMNIVOICE_URL || !env.OMNIVOICE_TOKEN) {
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
    referenceAudioId?: string
    language?: string
  }
  try {
    body = await request.json()
  } catch {
    return new Response("expected JSON body", { status: 400 })
  }

  const { projectId, fileId, text, referenceAudioId, language } = body
  if (!projectId || !fileId || !text) {
    return new Response("missing projectId, fileId, or text", { status: 400 })
  }
  // Bound text size — an authenticated caller could otherwise exhaust the GPU
  // request timeout with a multi-MB payload.
  if (text.length > 10_000) {
    return new Response("text too long (max 10000 chars)", { status: 400 })
  }
  // Sanitize the reference id before it becomes part of an R2 key.
  if (referenceAudioId !== undefined && !/^[\w.-]+$/.test(referenceAudioId)) {
    return new Response("invalid referenceAudioId", { status: 400 })
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
  // (sync-worker/src/events/export-floor.ts line 37)
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

  // Optionally resolve a reference clip for voice cloning.
  let referenceBytes: ArrayBuffer | undefined
  let referenceType = "audio/wav"
  if (referenceAudioId) {
    // Reference clips live project-scoped at the same path voice-convert uses.
    const refKey = `${r2KeyPrefix(env)}projects/${projectId}/voices/${referenceAudioId}`
    const refObj = await env.SNAPSHOTS.get(refKey)
    if (!refObj) return new Response("reference audio not found", { status: 404 })
    referenceBytes = await refObj.arrayBuffer()
    referenceType = refObj.httpMetadata?.contentType || referenceType
  }

  // Call OmniVoice on Modal.
  const modalBody = new FormData()
  modalBody.append("text", text)
  if (language) modalBody.append("language", language)
  if (referenceBytes) {
    modalBody.append(
      "voice_ref",
      new Blob([referenceBytes], { type: referenceType }),
      "reference",
    )
  }

  let modalRes: Response
  try {
    modalRes = await fetch(`${env.OMNIVOICE_URL}/synthesize`, {
      method: "POST",
      headers: { "X-Auth-Token": env.OMNIVOICE_TOKEN },
      body: modalBody,
    })
  } catch (err) {
    return new Response(`TTS upstream unreachable: ${String(err)}`, { status: 502 })
  }
  if (!modalRes.ok) {
    const detail = await modalRes.text().catch(() => "")
    return new Response(`TTS failed (${modalRes.status}): ${detail}`.trim(), { status: 502 })
  }

  const wavBytes = await modalRes.arrayBuffer()

  // Parse the duration header (the metering unit). Guard against a malformed
  // or absent value: Number("NaN"/"inf"/junk) or a negative would corrupt the
  // audio_seconds counter (a NaN SUM permanently defeats the daily cap). Clamp
  // to a finite, non-negative number.
  const durationHeader = modalRes.headers.get("X-Audio-Duration-Seconds")
  const parsedDuration = Number(durationHeader)
  const durationSeconds =
    durationHeader && Number.isFinite(parsedDuration) ? Math.max(0, parsedDuration) : 0
  if (!durationHeader || !Number.isFinite(parsedDuration)) {
    // Our own omnivoice.py always sets this header; a miss means a Modal
    // contract/version drift. Metering can't account for this clip — surface it
    // loudly (the spend control silently under-counts otherwise).
    console.warn(
      `[tts] missing/invalid X-Audio-Duration-Seconds (got ${JSON.stringify(durationHeader)}) — recording 0s for user ${userId} org ${orgId}`,
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
