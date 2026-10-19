// Agent API transcription (Omnilingual ASR spec §7).
//
//   POST /api/v1/external/projects/:projectId/transcriptions
//     { laneId?, fileId?, cellId?, audio?: { data, format: "wav" }, model?,
//       language?, exampleCellIds? }
//     → { text, words: [{ text, start, end }], model, timingsApproximate, creditsCharged }
//   POST /api/v1/external/projects/:projectId/transcriptions/status
//     { model: "omni-zs" | "omni-ctc", warm? } → { state, estGpuSecPerAudioSec? }
//
// Either transcribe a cell's selected recorded take (fileId + cellId + laneId)
// or raw canonical WAV (16 kHz mono PCM16). The result is OUTPUT ONLY: nothing
// is written. To store a transcript an agent stages it with prepare_translations
// (SetTranslation / SetTranscription), so the changeset/approval gate applies.
//
// Billing and gating are NOT re-implemented here. Every window goes to
// auth-worker's POST /api/v1/audio/internal/transcriptions (shared
// SYNC_SECRET_KEY, the DraftCells pattern), which runs the same code as the
// in-app route: model routing, the org zero-shot gate, spend ceiling, rate
// limit, reservation and settlement. The price of that seam: a PR preview
// sync-worker cannot reach a preview auth-worker (docs/DEPLOYMENT-ENVIRONMENTS.md),
// so this tool only works on dev/prod. Moving the weekly-usage ledger into
// db/shared to avoid the hop would be a much larger change than this feature.
//
// Auth: a PROJECT-scoped `aqk_` credential with write access (it spends the
// workspace's credits), owned by a contributor or above.

import { errorResponse, type ExternalErrorCode } from './errors'
import { authArtifact } from './artifacts-route'
import { resolveExternalLaneParam } from './external-lane'
import { publicBaseFrom } from './mcp-oauth-metadata'
import { ROLE } from '../events/role-policy'
import { laneLanguageCode } from '../../../src/lib/lanes/lane-display'
import type { ExternalEnv } from './types'
import { audioObjectKey, isPathSafeId } from '../audio'
import { selectTranscriptionExamples, sourceTextOf, type TranscriptionExample } from '../events/transcription-examples-route'
import { canonicalWavSamples, toBase64, windowCanonicalWav, SAMPLE_RATE, type WavWindow } from './wav-windows'
import {
  ASR_MODEL_CHOICES, ASR_WINDOW_SECONDS, pickAsrModel, type AsrModel, type AsrModelChoice,
} from '../../../db/shared/asr-models'

const ROUTE_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/transcriptions(\/status)?$/

/** auth-worker's body limit is 2.7 MB of JSON; keep each audio part under it. */
const MAX_AUDIO_BYTES = 1_900_000
/** Raw uploads may be long; they are windowed. 10 min of 16 kHz PCM16. */
const MAX_RAW_WAV_BYTES = 10 * 60 * SAMPLE_RATE * 2 + 44

const MIME_FORMATS: Record<string, string> = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac',
}
const EXT_FORMATS: Record<string, string> = {
  webm: 'webm', ogg: 'ogg', opus: 'ogg', wav: 'wav', mp3: 'mp3', m4a: 'm4a', mp4: 'm4a', flac: 'flac', aac: 'aac',
}

export function takeFormat(mime: string | null, audioId: string): string | undefined {
  const fromMime = mime ? MIME_FORMATS[mime.split(';')[0].trim().toLowerCase()] : undefined
  return fromMime ?? EXT_FORMATS[audioId.split('.').pop()?.toLowerCase() ?? '']
}

/** auth-worker error strings → this API's stable codes, with what to do next. */
function upstreamError(status: number, error: string, retryAfter: string | null): Response {
  if (error === 'asr_warming') {
    return errorResponse('job_failed', 'the zero-shot model is starting (cold start, about 2 minutes)', {
      reason: 'asr_warming',
      retryAfterSeconds: Number(retryAfter ?? 10),
      nextStep: 'call transcription_status { model: "omni-zs", warm: true }, poll it until state is "ready", then retry',
    })
  }
  if (error === 'zero_shot_disabled') {
    return errorResponse('permission_denied', 'this organization has turned zero-shot transcription off', { reason: error })
  }
  if (error === 'zs_no_examples') {
    return errorResponse('validation_failed', 'zero-shot needs at least one recorded and transcribed cell in this lane', { reason: error })
  }
  if (error === 'audio_format_unsupported_for_model') {
    return errorResponse('validation_failed',
      'this take is webm, which Whisper/Qwen3-ASR cannot read; pass model "omni-ctc" or "omni-zs", or upload WAV as audio', { reason: error })
  }
  const code: ExternalErrorCode = status === 429 || error === 'credit_cap_exceeded' || error === 'weekly_ai_allowance_exhausted'
    ? 'rate_limited'
    : status === 403 ? 'permission_denied'
      : status === 400 ? 'validation_failed'
        : status === 409 ? 'conflict'
          : 'job_failed'
  return errorResponse(code, `transcription failed: ${error}`, { reason: error })
}

interface Word { text: string; start: number; end: number }
interface WindowResult {
  text: string
  chunks: Word[]
  model: AsrModel
  timingsApproximate: boolean
  creditsCharged: number | null
}

async function callAuthWorker(env: ExternalEnv, path: string, body: unknown): Promise<Response> {
  if (!env.AUTH_WORKER_URL || !env.SYNC_SECRET_KEY) {
    return errorResponse('job_failed', 'transcription backend is not configured in this environment')
  }
  try {
    return await fetch(`${env.AUTH_WORKER_URL.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SYNC_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(320000),
    })
  } catch {
    return errorResponse('job_failed', 'transcription backend unavailable')
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

const strField = (body: Record<string, unknown>, key: string) =>
  typeof body[key] === 'string' && (body[key] as string).length > 0 ? body[key] as string : undefined

export async function handleExternalTranscriptionRequest(
  request: Request,
  env: ExternalEnv & { DIARIZATION_PUBLIC_BASE?: string },
  mountPrefix = '',
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(ROUTE_RE)
  if (!match) return null
  if (request.method !== 'POST') return errorResponse('validation_failed', 'use POST')
  const projectId = decodeURIComponent(match[1])

  const authed = await authArtifact(request, env, projectId, ROLE.CONTRIBUTOR, {
    writes: true, action: 'transcribe audio (it spends workspace credits)',
  })
  if (!authed.ok) return authed.response
  if (authed.cred.projectId == null) {
    return errorResponse('scope_denied', 'transcription needs a credential scoped to this one project')
  }
  const db = env.AQUILLA_PG as AquillaDb
  const userId = authed.cred.userId
  const body = await readBody(request)
  if (!body) return errorResponse('validation_failed', 'body must be a JSON object')

  if (match[2]) {
    const model = body.model ?? 'omni-zs'
    if (model !== 'omni-zs' && model !== 'omni-ctc') {
      return errorResponse('validation_failed', 'model must be "omni-zs" or "omni-ctc" (Whisper and Qwen need no warm-up)')
    }
    const res = await callAuthWorker(env, '/api/v1/audio/internal/transcriptions/status', {
      projectId, userId, model, action: body.warm === true ? 'warm' : 'status',
    })
    const reply = await res.json().catch(() => null) as { error?: string | object } | null
    if (!res.ok) {
      return typeof reply?.error === 'string' ? upstreamError(res.status, reply.error, null) : errorResponse('job_failed', 'transcription status unavailable')
    }
    return Response.json(reply)
  }

  const choice = body.model ?? 'auto'
  if (typeof choice !== 'string' || !(ASR_MODEL_CHOICES as readonly string[]).includes(choice)) {
    return errorResponse('validation_failed', `model must be one of ${ASR_MODEL_CHOICES.join(', ')}`)
  }
  const laneId = strField(body, 'laneId') ?? null
  const fileId = strField(body, 'fileId')
  const cellId = strField(body, 'cellId')
  const rawAudio = body.audio as { data?: unknown; format?: unknown } | undefined
  if (rawAudio !== undefined && (fileId || cellId)) {
    return errorResponse('validation_failed', 'pass either audio, or fileId + cellId, not both')
  }
  if (rawAudio === undefined && !(fileId && cellId)) {
    return errorResponse('validation_failed', 'pass fileId + cellId (with laneId) to transcribe a cell\'s take, or audio { data, format: "wav" }')
  }
  const exampleCellIds = body.exampleCellIds
  if (exampleCellIds !== undefined && (!Array.isArray(exampleCellIds) || exampleCellIds.length > 10
    || !exampleCellIds.every(id => typeof id === 'string' && id.length > 0))) {
    return errorResponse('validation_failed', 'exampleCellIds must be an array of at most 10 cell ids')
  }

  // A lane is needed to find a cell's take, and for zero-shot examples.
  let lane: { id: string; language: string; legacyTag: string | null } | null = null
  if (laneId !== null || cellId) {
    const resolved = await resolveExternalLaneParam(db, env.LANE_READ_WALL, projectId, Number(userId), authed.role, laneId, 'laneId')
    if (!resolved.ok) return errorResponse('validation_failed', resolved.message)
    lane = resolved.lane
  }
  // lanes.language is a display label ("Dholuo"); the tag is its code.
  let language = strField(body, 'language')
  if (language === undefined && lane) {
    const row = await db.prepare('SELECT language, name, lang_code FROM lanes WHERE id = ?')
      .bind(lane.id).first<{ language: string | null; name: string | null; lang_code: string | null }>()
    language = (row && laneLanguageCode(
      { role: 'target', language: row.language, name: row.name, langCode: row.lang_code },
      { legacyTag: lane.legacyTag ?? undefined },
    )) || undefined
  }
  if (language !== undefined && !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(language)) {
    return errorResponse('validation_failed', 'language must be a BCP-47 tag such as "luo" or "tpi-Latn"')
  }
  const model: AsrModel = choice === 'auto' ? pickAsrModel(language) : choice as Exclude<AsrModelChoice, 'auto'>

  // ── the audio, as one or more request windows ─────────────────────────
  let parts: Array<{ audio: { data: string; format: string; durationMs?: number }; offsetSeconds: number }>
  if (rawAudio !== undefined) {
    if (rawAudio.format !== 'wav' || typeof rawAudio.data !== 'string') {
      return errorResponse('validation_failed', 'audio must be { data: <base64>, format: "wav" } — 16 kHz mono PCM16 WAV')
    }
    let bytes: Uint8Array
    try { bytes = Uint8Array.from(atob(rawAudio.data), ch => ch.charCodeAt(0)) }
    catch { return errorResponse('validation_failed', 'audio.data must be base64') }
    if (bytes.length > MAX_RAW_WAV_BYTES) return errorResponse('validation_failed', 'audio is longer than 10 minutes')
    const samples = canonicalWavSamples(bytes)
    if (!samples) return errorResponse('validation_failed', 'audio must be 16 kHz mono PCM16 WAV with a 44-byte header')
    parts = windowCanonicalWav(samples, ASR_WINDOW_SECONDS[model]).map((w: WavWindow) => ({
      audio: { data: w.base64, format: 'wav' }, offsetSeconds: w.offsetSeconds,
    }))
  } else {
    if (!isPathSafeId(fileId!) || !lane) return errorResponse('validation_failed', 'invalid fileId')
    const take = await db.prepare(
      `SELECT audio_id, mime_type, duration_ms FROM cell_audio
        WHERE project_id = ? AND file_id = ? AND cell_id = ? AND deleted = 0 AND selected = 1
          AND role = 'dub' AND slot = 'recording'
          AND (lane_id = ? OR (lane_id IS NULL AND ? = ''))
        ORDER BY created_ts DESC LIMIT 1`,
    ).bind(projectId, fileId, cellId, lane.id, lane.legacyTag ?? '\u0000').first<{
      audio_id: string; mime_type: string | null; duration_ms: number | string | null
    }>()
    if (!take || !isPathSafeId(take.audio_id)) return errorResponse('not_found', 'this cell has no selected recorded take in that lane')
    if (!env.SNAPSHOTS) return errorResponse('job_failed', 'audio storage is not configured')
    const object = await env.SNAPSHOTS.get(audioObjectKey(env, projectId, fileId!, take.audio_id))
    if (!object) return errorResponse('not_found', 'the take\'s audio is missing from storage')
    const bytes = new Uint8Array(await object.arrayBuffer())
    const format = takeFormat(take.mime_type, take.audio_id)
    const samples = format === 'wav' ? canonicalWavSamples(bytes) : null
    if (samples) {
      parts = windowCanonicalWav(samples, ASR_WINDOW_SECONDS[model]).map(w => ({
        audio: { data: w.base64, format: 'wav' }, offsetSeconds: w.offsetSeconds,
      }))
    } else {
      // Compressed takes cannot be cut in a Worker: they must fit one window.
      const durationMs = Number(take.duration_ms)
      if (!format || format === 'wav') return errorResponse('validation_failed', 'the take\'s audio format is not supported')
      if (!Number.isFinite(durationMs) || durationMs <= 0) return errorResponse('validation_failed', 'the take has no recorded duration')
      if (durationMs > ASR_WINDOW_SECONDS[model] * 1000) {
        return errorResponse('validation_failed',
          `this ${format} take is ${Math.round(durationMs / 1000)} s; ${model} takes at most ${ASR_WINDOW_SECONDS[model]} s per request. Cut the take in the app, or send WAV as audio and it will be windowed.`)
      }
      if (bytes.length > MAX_AUDIO_BYTES) return errorResponse('validation_failed', 'the take is too large to transcribe in one request')
      parts = [{ audio: { data: toBase64(bytes), format, durationMs: Math.round(durationMs) }, offsetSeconds: 0 }]
    }
  }

  // ── zero-shot examples (spec §4 ranking, or the caller's named cells) ─
  let examples: Array<{ url: string; text: string }> | undefined
  if (model === 'omni-zs') {
    if (!lane) return errorResponse('validation_failed', 'zero-shot needs laneId: its examples come from that lane\'s recordings')
    const publicBase = env.DIARIZATION_PUBLIC_BASE?.trim() || env.externalPublicBase || publicBaseFrom(request.url, mountPrefix)
    const picked: TranscriptionExample[] = await selectTranscriptionExamples(env, {
      projectId, laneId: lane.id, laneTag: lane.legacyTag, excludeCellId: cellId,
      sourceText: cellId ? await sourceTextOf(db, projectId, cellId, fileId) : undefined,
      limit: 10, publicBase, onlyCellIds: exampleCellIds as string[] | undefined,
    })
    if (picked.length === 0) {
      return upstreamError(400, 'zs_no_examples', null)
    }
    examples = picked.map(e => ({ url: e.audioUrl, text: e.text }))
  }

  // ── run each window through auth-worker's shared path ─────────────────
  const results: WindowResult[] = []
  for (const part of parts) {
    const res = await callAuthWorker(env, '/api/v1/audio/internal/transcriptions', {
      projectId, userId, model, audio: part.audio, requestId: crypto.randomUUID(),
      ...(language ? { language } : {}), ...(examples ? { examples } : {}),
    })
    const reply = await res.json().catch(() => null) as (WindowResult & { error?: unknown }) | null
    if (!res.ok || !reply || typeof reply.text !== 'string') {
      if (typeof reply?.error === 'string') return upstreamError(res.status, reply.error, res.headers.get('Retry-After'))
      return res.ok ? errorResponse('job_failed', 'invalid transcription response') : res
    }
    results.push({ ...reply, chunks: reply.chunks.map(w => ({ ...w, start: w.start + part.offsetSeconds, end: w.end + part.offsetSeconds })) })
  }
  const charged = results.map(r => r.creditsCharged)
  return Response.json({
    text: results.map(r => r.text.trim()).filter(Boolean).join(' '),
    words: results.flatMap(r => r.chunks),
    model: results[0]?.model ?? model,
    timingsApproximate: results.some(r => r.timingsApproximate),
    creditsCharged: charged.every(c => typeof c === 'number') ? charged.reduce<number>((a, c) => a + (c as number), 0) : null,
  })
}
