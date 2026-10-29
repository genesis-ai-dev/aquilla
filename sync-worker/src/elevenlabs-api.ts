// ElevenLabs upstream client (AQU-2299) — bring-your-own-key.
//
// The caller's key arrives per request (the browser sends it in
// `X-ElevenLabs-Key`) and is forwarded verbatim as `xi-api-key`. It is never
// stored, never put in a URL, and never logged: every log line in this module
// and in elevenlabs.ts names the route and the upstream status only.
//
// Endpoints used (https://elevenlabs.io/docs/api-reference):
//   GET  /v1/user/subscription            …/user/subscription/get
//   GET  /v2/voices                       …/voices/search
//   GET  /v1/models                       …/models/list
//   POST /v1/text-to-speech/{voice_id}    …/text-to-speech/convert
//   POST /v1/voice-changer/{voice_id}     …/speech-to-speech/convert
//   POST /v1/voices/add                   …/voices/ivc/create
//
// Errors share one envelope (https://elevenlabs.io/docs/developers/resources/errors):
//   { "detail": { "type", "code", "message", "status" } }
// `status` is the legacy field older accounts still get (e.g. a 401 whose
// status is "quota_exceeded"), so both are read.

import {
  isAbortTimeout,
  logVendorTimeout,
  VENDOR_TIMEOUT_MS,
  type VendorName,
} from "../../shared/vendor-timeouts"

export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io"

/** mp3 at 44.1 kHz / 128 kbps CBR — the API default, available on every tier. */
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128"
const OUTPUT_BITS_PER_SECOND = 128_000

export const ELEVENLABS_DEFAULT_TTS_MODEL = "eleven_multilingual_v2"
export const ELEVENLABS_STS_MODEL = "eleven_multilingual_sts_v2"

/**
 * The TTS models we offer, in picker order. `/v1/models` lists far more
 * (speech-to-speech models, legacy English-only ones); the route intersects
 * the account's list with this one so a model the key can't use never shows.
 */
export const ELEVENLABS_TTS_MODELS: readonly { id: string; name: string }[] = [
  { id: "eleven_multilingual_v2", name: "Multilingual v2" },
  { id: "eleven_v3", name: "Eleven v3" },
  { id: "eleven_flash_v2_5", name: "Flash v2.5" },
]

/** The synthesize endpoint's own limit is higher; this keeps one cell sane. */
export const ELEVENLABS_MAX_TEXT_CHARS = 5000

/** Stable error codes the client maps to copy (src/lib/audio/elevenlabs/errors.ts). */
export type ElevenLabsErrorCode =
  | "elevenlabs_key_missing"
  | "elevenlabs_invalid_key"
  | "elevenlabs_quota_exceeded"
  | "elevenlabs_clone_not_allowed"
  | "elevenlabs_rate_limited"
  | "elevenlabs_timeout"
  | "elevenlabs_failed"

export class ElevenLabsUpstreamError extends Error {
  readonly status: number
  readonly code: ElevenLabsErrorCode
  constructor(status: number, code: ElevenLabsErrorCode, message: string) {
    super(message)
    this.name = "ElevenLabsUpstreamError"
    this.status = status
    this.code = code
  }
}

/** The JSON body every ElevenLabs failure is answered with. */
export function elevenLabsErrorResponse(err: ElevenLabsUpstreamError): Response {
  return Response.json(
    { error: err.code, message: err.message },
    { status: err.status, ...(err.status === 429 ? { headers: { "Retry-After": "30" } } : {}) },
  )
}

interface UpstreamDetail {
  code: string
  status: string
  message: string
}

function readDetail(bodyText: string): UpstreamDetail {
  try {
    const parsed = JSON.parse(bodyText) as { detail?: unknown }
    const d = parsed.detail
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const rec = d as Record<string, unknown>
      return {
        code: typeof rec.code === "string" ? rec.code : "",
        status: typeof rec.status === "string" ? rec.status : "",
        message: typeof rec.message === "string" ? rec.message : "",
      }
    }
    if (typeof d === "string") return { code: "", status: "", message: d }
  } catch {
    // Not JSON — fall through with the raw text (trimmed below).
  }
  return { code: "", status: "", message: bodyText.slice(0, 300) }
}

/**
 * Map an upstream failure to our status + code. Order matters: quota is
 * checked before the generic 401, because ElevenLabs' legacy envelope answers
 * an exhausted account with 401 + status "quota_exceeded".
 */
export function mapElevenLabsError(
  upstreamStatus: number,
  bodyText: string,
  context: "tts" | "sts" | "clone" | "read",
): ElevenLabsUpstreamError {
  const detail = readDetail(bodyText)
  const codes = `${detail.code} ${detail.status}`.toLowerCase()
  const text = `${codes} ${detail.message}`.toLowerCase()

  if (
    upstreamStatus === 402
    || /quota_exceeded|insufficient_credits|character_limit/.test(codes)
  ) {
    return new ElevenLabsUpstreamError(402, "elevenlabs_quota_exceeded", "ElevenLabs account is out of characters")
  }
  if (upstreamStatus === 401) {
    return new ElevenLabsUpstreamError(401, "elevenlabs_invalid_key", "ElevenLabs rejected the API key")
  }
  if (
    context === "clone"
    && (upstreamStatus === 403 || /can_not_use_instant_voice_cloning|feature_not_available|subscription_required/.test(text))
  ) {
    return new ElevenLabsUpstreamError(403, "elevenlabs_clone_not_allowed", "ElevenLabs plan does not include instant voice cloning")
  }
  if (upstreamStatus === 429) {
    return new ElevenLabsUpstreamError(429, "elevenlabs_rate_limited", "ElevenLabs rate limited the request")
  }
  // 4xx stays a 4xx (the request itself was wrong — a bad voice id, an
  // unusable model); everything else is the upstream failing, a 502.
  const status = upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502
  const why = detail.message.trim() || `HTTP ${upstreamStatus}`
  return new ElevenLabsUpstreamError(status, "elevenlabs_failed", `ElevenLabs ${context} failed (${upstreamStatus}): ${why}`)
}

export interface ElevenLabsConfig {
  /** The caller's own key. Never logged. */
  apiKey: string
  baseUrl: string
}

export function elevenLabsBaseUrl(env: { ELEVENLABS_BASE_URL?: string }): string {
  return (env.ELEVENLABS_BASE_URL?.trim() || DEFAULT_ELEVENLABS_BASE_URL).replace(/\/+$/, "")
}

/** One upstream call, bounded by its vendor deadline. Returns only an OK response. */
async function upstream(
  config: ElevenLabsConfig,
  path: string,
  init: RequestInit,
  vendor: Extract<VendorName, "elevenLabsAudio" | "elevenLabsClone" | "elevenLabsMetadata">,
  context: "tts" | "sts" | "clone" | "read",
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set("xi-api-key", config.apiKey)
  let res: Response
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS[vendor]),
    })
  } catch (err) {
    if (isAbortTimeout(err)) {
      logVendorTimeout(vendor)
      throw new ElevenLabsUpstreamError(504, "elevenlabs_timeout", `ElevenLabs did not respond within ${Math.round(VENDOR_TIMEOUT_MS[vendor] / 1000)}s`)
    }
    // The error object can carry the request (and its headers) — log only its name.
    console.error(`[elevenlabs] ${context} upstream unreachable:`, err instanceof Error ? err.name : "unknown")
    throw new ElevenLabsUpstreamError(502, "elevenlabs_failed", `ElevenLabs ${context} failed: upstream unreachable`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    console.warn(`[elevenlabs] ${context} upstream answered ${res.status}`)
    throw mapElevenLabsError(res.status, body, context)
  }
  return res
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface ElevenLabsAccount {
  tier: string
  characterCount: number
  characterLimit: number
  canClone: boolean
  /** Unix seconds; null when the plan has no reset. */
  resetAtUnix: number | null
}

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback)

export async function getElevenLabsAccount(config: ElevenLabsConfig): Promise<ElevenLabsAccount> {
  const res = await upstream(config, "/v1/user/subscription", { method: "GET" }, "elevenLabsMetadata", "read")
  const json = (await res.json()) as Record<string, unknown>
  return {
    tier: typeof json.tier === "string" ? json.tier : "free",
    characterCount: num(json.character_count),
    characterLimit: num(json.character_limit),
    canClone: json.can_use_instant_voice_cloning === true,
    resetAtUnix: typeof json.next_character_count_reset_unix === "number" ? json.next_character_count_reset_unix : null,
  }
}

export type ElevenLabsVoiceCategory = "premade" | "cloned" | "generated" | "professional"
const VOICE_CATEGORIES: readonly ElevenLabsVoiceCategory[] = ["premade", "cloned", "generated", "professional"]

export function isElevenLabsVoiceCategory(v: unknown): v is ElevenLabsVoiceCategory {
  return typeof v === "string" && (VOICE_CATEGORIES as readonly string[]).includes(v)
}

export interface ElevenLabsVoiceRow {
  id: string
  name: string
  /** famous / high_quality (response-only categories) fold into premade. */
  category: ElevenLabsVoiceCategory
  labels: Record<string, string>
  previewUrl: string | null
  description: string | null
}

function voiceRow(raw: unknown): ElevenLabsVoiceRow | null {
  if (!raw || typeof raw !== "object") return null
  const v = raw as Record<string, unknown>
  if (typeof v.voice_id !== "string" || !v.voice_id) return null
  const labels: Record<string, string> = {}
  if (v.labels && typeof v.labels === "object") {
    for (const [k, val] of Object.entries(v.labels as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) labels[k] = val.trim()
    }
  }
  return {
    id: v.voice_id,
    name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : v.voice_id,
    category: isElevenLabsVoiceCategory(v.category) ? v.category : "premade",
    labels,
    previewUrl: typeof v.preview_url === "string" && v.preview_url ? v.preview_url : null,
    description: typeof v.description === "string" && v.description.trim() ? v.description.trim() : null,
  }
}

export interface ElevenLabsVoicePage {
  voices: ElevenLabsVoiceRow[]
  nextPageToken: string | null
}

export async function listElevenLabsVoices(
  config: ElevenLabsConfig,
  opts: { search?: string; category?: ElevenLabsVoiceCategory; pageToken?: string; pageSize?: number },
): Promise<ElevenLabsVoicePage> {
  const params = new URLSearchParams({ page_size: String(Math.min(100, Math.max(1, opts.pageSize ?? 100))) })
  if (opts.search) params.set("search", opts.search)
  if (opts.category) params.set("category", opts.category)
  if (opts.pageToken) params.set("next_page_token", opts.pageToken)
  const res = await upstream(config, `/v2/voices?${params.toString()}`, { method: "GET" }, "elevenLabsMetadata", "read")
  const json = (await res.json()) as { voices?: unknown; has_more?: unknown; next_page_token?: unknown }
  const voices = Array.isArray(json.voices) ? json.voices.flatMap((v) => voiceRow(v) ?? []) : []
  const nextPageToken = json.has_more === true && typeof json.next_page_token === "string" ? json.next_page_token : null
  return { voices, nextPageToken }
}

export interface ElevenLabsModelRow {
  id: string
  name: string
}

/** The curated TTS models this account can use, in our order. */
export async function listElevenLabsModels(config: ElevenLabsConfig): Promise<ElevenLabsModelRow[]> {
  const res = await upstream(config, "/v1/models", { method: "GET" }, "elevenLabsMetadata", "read")
  const json = (await res.json()) as unknown
  const available = new Set(
    (Array.isArray(json) ? json : []).flatMap((m) => {
      const rec = m as Record<string, unknown> | null
      return rec && typeof rec.model_id === "string" && rec.can_do_text_to_speech !== false ? [rec.model_id] : []
    }),
  )
  return ELEVENLABS_TTS_MODELS.filter((m) => available.has(m.id))
}

// ── Audio ────────────────────────────────────────────────────────────────────

export interface ElevenLabsVoiceSettings {
  stability: number
  similarity_boost: number
  style: number
  speed: number
  use_speaker_boost: boolean
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Client voice settings (camelCase) → the API's snake_case `voice_settings`,
 * clamped to the documented ranges (speed 0.7–1.2). Null when absent, so the
 * voice's stored settings apply.
 */
export function parseVoiceSettings(raw: unknown): ElevenLabsVoiceSettings | null {
  if (!raw || typeof raw !== "object") return null
  const s = raw as Record<string, unknown>
  return {
    stability: clamp(s.stability, 0, 1, 0.5),
    similarity_boost: clamp(s.similarityBoost, 0, 1, 0.75),
    style: clamp(s.style, 0, 1, 0),
    speed: clamp(s.speed, 0.7, 1.2, 1),
    use_speaker_boost: s.speakerBoost !== false,
  }
}

/** Seconds of a CBR mp3 in our output format, from its byte length. */
export function mp3DurationSeconds(byteLength: number): number {
  return Math.max(0, (byteLength * 8) / OUTPUT_BITS_PER_SECOND)
}

const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export function isElevenLabsVoiceId(v: unknown): v is string {
  return typeof v === "string" && VOICE_ID_RE.test(v)
}
const MODEL_ID_RE = /^[a-z0-9_]{1,64}$/
export function isElevenLabsModelId(v: unknown): v is string {
  return typeof v === "string" && MODEL_ID_RE.test(v)
}

export async function synthesizeElevenLabs(
  config: ElevenLabsConfig,
  req: { voiceId: string; text: string; modelId: string; voiceSettings: ElevenLabsVoiceSettings | null; languageCode?: string },
): Promise<ArrayBuffer> {
  const body: Record<string, unknown> = { text: req.text, model_id: req.modelId }
  if (req.voiceSettings) body.voice_settings = req.voiceSettings
  // `language_code` is not supported by the multilingual_v2 models (docs).
  if (req.languageCode && !req.modelId.startsWith("eleven_multilingual_v2")) body.language_code = req.languageCode
  const res = await upstream(
    config,
    `/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
    { method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/mpeg" }, body: JSON.stringify(body) },
    "elevenLabsAudio",
    "tts",
  )
  return res.arrayBuffer()
}

export async function convertSpeechElevenLabs(
  config: ElevenLabsConfig,
  req: { voiceId: string; audio: Blob; modelId: string; voiceSettings: ElevenLabsVoiceSettings | null },
): Promise<ArrayBuffer> {
  const form = new FormData()
  form.append("audio", req.audio, "source")
  form.append("model_id", req.modelId)
  if (req.voiceSettings) form.append("voice_settings", JSON.stringify(req.voiceSettings))
  const res = await upstream(
    config,
    `/v1/voice-changer/${encodeURIComponent(req.voiceId)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
    { method: "POST", headers: { Accept: "audio/mpeg" }, body: form },
    "elevenLabsAudio",
    "sts",
  )
  return res.arrayBuffer()
}

export async function cloneElevenLabsVoice(
  config: ElevenLabsConfig,
  req: { name: string; files: { blob: Blob; name: string }[]; removeBackgroundNoise: boolean; description?: string; labels?: Record<string, string> },
): Promise<{ voiceId: string; requiresVerification: boolean }> {
  const form = new FormData()
  form.append("name", req.name)
  for (const f of req.files) form.append("files", f.blob, f.name)
  form.append("remove_background_noise", req.removeBackgroundNoise ? "true" : "false")
  if (req.description) form.append("description", req.description)
  if (req.labels && Object.keys(req.labels).length > 0) form.append("labels", JSON.stringify(req.labels))
  const res = await upstream(config, "/v1/voices/add", { method: "POST", body: form }, "elevenLabsClone", "clone")
  const json = (await res.json()) as { voice_id?: unknown; requires_verification?: unknown }
  if (typeof json.voice_id !== "string" || !json.voice_id) {
    throw new ElevenLabsUpstreamError(502, "elevenlabs_failed", "ElevenLabs clone failed: no voice id in the response")
  }
  return { voiceId: json.voice_id, requiresVerification: json.requires_verification === true }
}
