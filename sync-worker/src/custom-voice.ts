// Custom voices: an RVC voice model trained from an organization's own recordings
// of a real speaker (infra/modal/voice_forge.py `custom_train`), used afterwards
// exactly like a built-in character voice through /api/v1/voice/convert.
//
// Consent is the organization's responsibility. Aquilla does not collect or check
// releases; it requires an explicit confirmation from a maintainer that the org
// holds the speaker's informed consent and that the use complies with the laws that
// apply to it, and keeps that confirmation (who, when, what statement, which
// recordings) as an audit record next to the voice:
//
//   {prefix}projects/{projectId}/voices/custom/{voiceId}/consent.json
//
// That record is also what scopes the voice to its project: voice-convert refuses a
// custom voice id with no consent record under the calling project, so one org's
// trained voice of a real person can never be used from another project.
//
//   POST /api/v1/voice/custom/:projectId                 start training
//   GET  /api/v1/voice/custom/:projectId/:voiceId/status  queued | training | ready | failed
//   GET  /api/v1/voice/custom/:projectId/:voiceId/preview first ~10 s of the recordings

import { isPathSafeId, r2KeyPrefix } from "./audio"
import { verifyTokenForProject } from "./auth"
import { CUSTOM_VOICE_TRAIN_GPU, modalGpuRawCents } from "../../db/shared/audio-price-card"
import { entitleProjectAiCall, releaseQuietly, settleQuietly } from "./ai-metering"
import { enforceRateLimit, userRateLimitIdentifier } from "../../db/shared/rate-limit"
import { MAX_VOICE_CLIP_BYTES, voiceRefObjectKey, type VoiceConvertEnv } from "./voice-convert"

/** Training a voice of a real person is a project-level decision: maintainer and up,
 *  the same floor as editing the project's voice settings. */
export const CUSTOM_VOICE_ROLE_LEVEL = 600

/** At most this many recordings per voice (each ≤ MAX_VOICE_CLIP_BYTES). */
export const MAX_CUSTOM_VOICE_CLIPS = 40

/** Per-user starts per rate-limit window. A start is ~45 GPU-minutes. */
export const CUSTOM_VOICE_STARTS_PER_WINDOW = 5

/** Bills the reservation at a full training run (150 epochs ≈ 35 min on an A10G,
 *  plus preprocess); the job is async, so it settles at this estimate. */
export const CUSTOM_VOICE_TRAIN_ESTIMATE_SECONDS = 45 * 60

/**
 * The statement the maintainer confirms. Versioned so the audit record says exactly
 * what was agreed to; bump the version whenever the wording changes. Mirrored by
 * `CUSTOM_VOICE_CONSENT_VERSION` in src/lib/audio/custom-voice.ts.
 */
export const CUSTOM_VOICE_CONSENT_VERSION = "2026-10-23"
export const CUSTOM_VOICE_CONSENT_STATEMENT =
  "My organization has the informed consent of the person whose voice is in these recordings " +
  "to create an AI model of their voice and to use it in this project, and this use complies " +
  "with the laws, regulations and agreements that apply to my organization and to the speaker " +
  "(for example voice and likeness rights, data protection and union agreements). My " +
  "organization, not Aquilla, is responsible for obtaining, documenting and honouring that " +
  "consent, including any withdrawal of it."

export const CUSTOM_VOICE_ID_RE = /^c-[a-f0-9]{12,32}$/

export function isCustomVoiceId(id: string): boolean {
  return CUSTOM_VOICE_ID_RE.test(id)
}

export function customVoiceConsentKey(
  env: Pick<VoiceConvertEnv, "R2_KEY_PREFIX">,
  projectId: string,
  voiceId: string,
): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/voices/custom/${voiceId}/consent.json`
}

/** True when `voiceId` was trained in `projectId` (its consent record lives there). */
export async function customVoiceBelongsTo(
  env: Pick<VoiceConvertEnv, "SNAPSHOTS" | "R2_KEY_PREFIX">,
  projectId: string,
  voiceId: string,
): Promise<boolean> {
  return (await env.SNAPSHOTS.get(customVoiceConsentKey(env, projectId, voiceId))) != null
}

export interface CustomVoiceConsentRecord {
  voiceId: string
  projectId: string
  speakerName: string
  attestedByUserId: number
  attestedAt: string
  statementVersion: string
  statement: string
  referenceAudioIds: string[]
}

function newCustomVoiceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `c-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

function forgeBase(env: VoiceConvertEnv): string | null {
  // VOICE_FORGE_URL is the /convert endpoint; the custom routes are its siblings.
  return env.VOICE_FORGE_URL ? env.VOICE_FORGE_URL.replace(/\/convert\/?$/, "") : null
}

const START_RE = /^\/api\/v1\/voice\/custom\/([^/]+)$/
const READ_RE = /^\/api\/v1\/voice\/custom\/([^/]+)\/([^/]+)\/(status|preview)$/

export async function handleCustomVoiceRequest(
  request: Request,
  env: VoiceConvertEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const start = url.pathname.match(START_RE)
  const read = url.pathname.match(READ_RE)
  if (!start && !read) return null

  const projectId = decodeURIComponent((start ?? read)![1])
  if (!isPathSafeId(projectId)) return new Response("invalid projectId", { status: 400 })
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return new Response(verified.reason, { status: verified.status })

  const base = forgeBase(env)
  if (!base || !env.VOICE_FORGE_TOKEN) {
    return new Response("voice training not configured", { status: 503 })
  }

  if (read) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 })
    const voiceId = decodeURIComponent(read[2])
    if (!isCustomVoiceId(voiceId)) return new Response("invalid voiceId", { status: 400 })
    if (!(await customVoiceBelongsTo(env, projectId, voiceId))) {
      return new Response("voice not found", { status: 404 })
    }
    const upstream = await fetch(`${base}/voices/${voiceId}/${read[3]}`, {
      headers: { "X-Auth-Token": env.VOICE_FORGE_TOKEN },
    })
    if (!upstream.ok) {
      return new Response(await upstream.text().catch(() => ""), { status: upstream.status === 404 ? 404 : 502 })
    }
    return read[3] === "status"
      ? Response.json(await upstream.json())
      : new Response(await upstream.arrayBuffer(), {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=3600" },
      })
  }

  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (verified.claims.role < CUSTOM_VOICE_ROLE_LEVEL) {
    return new Response("training a custom voice requires maintainer role", { status: 403 })
  }

  let body: { speakerName?: unknown; referenceAudioIds?: unknown; consent?: { confirmed?: unknown; statementVersion?: unknown } }
  try {
    body = await request.json()
  } catch {
    return new Response("expected JSON", { status: 400 })
  }
  const speakerName = typeof body.speakerName === "string" ? body.speakerName.trim().slice(0, 120) : ""
  const refs = Array.isArray(body.referenceAudioIds)
    ? body.referenceAudioIds.filter((r): r is string => typeof r === "string")
    : []
  if (!speakerName) return new Response("missing speakerName", { status: 400 })
  if (refs.length === 0 || refs.length > MAX_CUSTOM_VOICE_CLIPS || refs.some((r) => !isPathSafeId(r))) {
    return new Response(`send 1-${MAX_CUSTOM_VOICE_CLIPS} referenceAudioIds`, { status: 400 })
  }
  // The confirmation is the gate: no consent statement, no training.
  if (body.consent?.confirmed !== true || body.consent.statementVersion !== CUSTOM_VOICE_CONSENT_VERSION) {
    return Response.json(
      { error: "consent_required", statementVersion: CUSTOM_VOICE_CONSENT_VERSION, statement: CUSTOM_VOICE_CONSENT_STATEMENT },
      { status: 422 },
    )
  }

  const db = env.AQUILLA_PG
  if (!db) return new Response("database not configured", { status: 500 })
  const limited = await enforceRateLimit(db, {
    kind: "voice_train",
    identifier: userRateLimitIdentifier(verified.claims.userId),
    limit: CUSTOM_VOICE_STARTS_PER_WINDOW,
    failMode: "closed",
  })
  if (!limited.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Too many voice trainings started, try again later." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    )
  }

  // Every recording must already be in this project's reference store and within
  // the per-clip cap — checked before anything is billed or uploaded.
  for (const ref of refs) {
    const obj = await env.SNAPSHOTS.get(voiceRefObjectKey(env, projectId, ref))
    if (!obj) return new Response(`recording not found: ${ref}`, { status: 404 })
    if (obj.size > MAX_VOICE_CLIP_BYTES) return new Response(`recording too large: ${ref}`, { status: 413 })
  }

  const estimate = modalGpuRawCents(CUSTOM_VOICE_TRAIN_GPU, CUSTOM_VOICE_TRAIN_ESTIMATE_SECONDS)
  const entitled = await entitleProjectAiCall(db, env, {
    projectId, userId: verified.claims.userId, rail: "gpu", provider: "modal", houseKey: env.VOICE_FORGE_TOKEN,
    estimateRawCents: estimate, requestId: crypto.randomUUID(),
  })
  if (!entitled.ok) return entitled.response
  const { grant } = entitled
  const forgeKey = grant.key.apiKey

  const voiceId = newCustomVoiceId()
  const record: CustomVoiceConsentRecord = {
    voiceId,
    projectId,
    speakerName,
    attestedByUserId: verified.claims.userId,
    attestedAt: new Date().toISOString(),
    statementVersion: CUSTOM_VOICE_CONSENT_VERSION,
    statement: CUSTOM_VOICE_CONSENT_STATEMENT,
    referenceAudioIds: refs,
  }
  // Written first: the audit record exists before any of the speaker's audio leaves R2.
  await env.SNAPSHOTS.put(customVoiceConsentKey(env, projectId, voiceId), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
  })

  // One clip per request, so the Worker never holds more than one recording.
  let uploadedSeconds = 0
  for (const [index, ref] of refs.entries()) {
    const obj = await env.SNAPSHOTS.get(voiceRefObjectKey(env, projectId, ref))
    if (!obj) return new Response(`recording not found: ${ref}`, { status: 404 })
    const form = new FormData()
    form.append("index", String(index))
    form.append("clip", await obj.blob(), ref)
    const res = await fetch(`${base}/voices/${voiceId}/clips`, {
      method: "POST", headers: { "X-Auth-Token": forgeKey }, body: form,
    })
    if (!res.ok) {
      await releaseQuietly(grant, "custom-voice")
      return new Response(`uploading ${ref} failed (${res.status}): ${await res.text().catch(() => "")}`.trim(), { status: 502 })
    }
    uploadedSeconds += Number(((await res.json()) as { seconds?: number }).seconds ?? 0)
  }

  const started = await fetch(`${base}/voices/${voiceId}/train`, {
    method: "POST", headers: { "X-Auth-Token": forgeKey },
  })
  if (!started.ok) {
    await releaseQuietly(grant, "custom-voice")
    return new Response(`starting training failed (${started.status}): ${await started.text().catch(() => "")}`.trim(), { status: 502 })
  }
  await settleQuietly(grant, estimate, "custom-voice")

  return Response.json({
    ok: true,
    voiceId,
    state: "queued",
    audioMinutes: Math.round((uploadedSeconds / 60) * 10) / 10,
    attestedAt: record.attestedAt,
    statementVersion: record.statementVersion,
  })
}
