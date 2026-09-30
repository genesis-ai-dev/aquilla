// Inworld TTS 2 Flash client used by POST /api/v1/voice/tts.
//
// Official REST (https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech):
//   POST https://api.inworld.ai/tts/v1/voice
//   Authorization: Basic $INWORLD_API_KEY
//   { text, voiceId, modelId, audioConfig (speakingRate), language?, deliveryMode? }
// Instant clone (https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice):
//   POST https://api.inworld.ai/voices/v1/voices:clone
//   { displayName, languageCode?, voiceSamples: [{ audioData: base64 }] }
// Voice design (https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/design-voice):
//   POST https://api.inworld.ai/voices/v1/voices:design
//   { designPrompt, designPromptMode?, previewText, languageCode?, voiceDesignConfig.numberOfSamples }
// Publish designed voice (https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/publish-voice):
//   POST https://api.inworld.ai/voices/v1/voices/{voiceId}:publish
//   { displayName, description?, tags? }
// List voices (https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices):
//   GET https://api.inworld.ai/voices/v1/voices?filter=source = "SYSTEM" AND lang_code = "en-US"
// Supported languages:
//   GET https://api.inworld.ai/voices/v1/supportedLanguages
//
export const DEFAULT_INWORLD_API_BASE = "https://api.inworld.ai"
export const DEFAULT_INWORLD_TTS_MODEL = "inworld-tts-2-flash"
export const INWORLD_TTS_MODEL_HIGHEST = "inworld-tts-2"
export const DEFAULT_INWORLD_VOICE = "Dennis"
export const INWORLD_MAX_TEXT_CHARS = 2000
export const INWORLD_SPEAKING_RATE_MIN = 0.5
export const INWORLD_SPEAKING_RATE_MAX = 1.5
export const DEFAULT_INWORLD_DELIVERY_MODE = "STABLE" as const
export const INWORLD_DESIGN_PROMPT_MIN = 30
export const INWORLD_DESIGN_PROMPT_MAX = 1000
export const INWORLD_DESIGN_SAMPLE_COUNT = 3
export const INWORLD_DESIGN_PROMPT_MODE_ASSISTED = "DESIGN_PROMPT_MODE_ASSISTED"
export const INWORLD_DESIGN_PROMPT_MODE_VERBATIM = "DESIGN_PROMPT_MODE_VERBATIM"
/**
 * AQU-1156: hard deadline on one upstream synthesis subrequest. Comfortably
 * above a real TTS-2 run on the longest text we accept
 * (`INWORLD_MAX_TEXT_CHARS`), and below the client's own
 * `TTS_REQUEST_TIMEOUT_MS` so this specific 502 wins the race and the user
 * reads why generation failed instead of watching a spinner.
 */
export const INWORLD_TTS_REQUEST_TIMEOUT_MS = 60_000

/** True for the DOMException `AbortSignal.timeout` rejects a fetch with. */
export function isAbortTimeout(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === "TimeoutError" || name === "AbortError"
}
/** BSB Revelation 1:17–18 — default spoken script for Voice Design previews. */
export const INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT =
  "Do not be afraid. I am the First and the Last, the Living One. I was dead, and behold, now I am alive forever and ever! And I hold the keys of Death and of Hades."

export interface InworldTtsConfig {
  apiKey: string
  apiBase?: string
  modelId?: string
  defaultVoiceId?: string
}

export interface SynthesizeInworldArgs {
  text: string
  voiceId?: string
  language?: string
  speakingRate?: unknown
  deliveryMode?: unknown
  audioQuality?: unknown
}

export interface SynthesizeInworldResult {
  wavBytes: ArrayBuffer
  durationSeconds: number
}

export interface CloneInworldArgs {
  displayName: string
  audioBytes: ArrayBuffer
  language?: string
}

export interface DesignInworldVoiceArgs {
  designPrompt: string
  previewText?: string
  language?: string
  numberOfSamples?: number
  designPromptMode?: "DESIGN_PROMPT_MODE_ASSISTED" | "DESIGN_PROMPT_MODE_VERBATIM"
}

export interface InworldDesignedPreview {
  voiceId: string
  previewText: string
  previewAudio: string
}

export interface PublishInworldVoiceArgs {
  voiceId: string
  displayName: string
  description?: string
}

export interface InworldCatalogVoice {
  voiceId: string
  displayName: string
  /** BCP-47 (en-US). Derived from Inworld's EN_US `langCode`. */
  language: string
  description?: string
}

const LIST_VOICES_PAGE_SIZE = 200
const LIST_VOICES_MAX_PAGES = 3
const SAFE_LANG_FILTER = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]+)*$/

const ISO_639_3_TO_BCP47: Record<string, string> = {
  ara: "ar",
  deu: "de-DE",
  eng: "en-US",
  spa: "es-ES",
  fra: "fr-FR",
  hin: "hi-IN",
  kor: "ko-KR",
  por: "pt-BR",
  ron: "ro-RO",
  rus: "ru-RU",
  vie: "vi-VN",
  yor: "yo",
  zho: "zh-CN",
  cmn: "zh-CN",
}

export function inworldAuthHeader(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (/^basic\s+/i.test(trimmed)) return trimmed
  return `Basic ${trimmed}`
}

export function inworldApiBase(config: InworldTtsConfig): string {
  return (config.apiBase?.trim() || DEFAULT_INWORLD_API_BASE).replace(/\/+$/, "")
}

/** Map project language tags (eng, en, en-US, EN_GB) onto Inworld's BCP-47.
 *  Keep in sync with src/lib/audio/inworld-languages.ts. */
export function toInworldLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === "auto") return undefined
  const normalized = trimmed.replace(/_/g, "-")
  const lower = normalized.toLowerCase()
  if (ISO_639_3_TO_BCP47[lower]) return ISO_639_3_TO_BCP47[lower]
  const primary = lower.split("-")[0]
  if (primary && ISO_639_3_TO_BCP47[primary]) {
    // Already a region-tagged BCP-47 (en-GB) — keep as-is after separator fix.
    return normalized.includes("-") ? normalized : ISO_639_3_TO_BCP47[primary]
  }
  // ISO 639-1 (2) or ISO 639-3 (3, e.g. fil, yue, ceb) plus optional subtags.
  if (/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(normalized)) return normalized
  return undefined
}

/** Inworld list-voices `langCode` is upper-snake (`EN_US`); badges use BCP-47. */
export function inworldLangCodeToBcp47(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.includes("-")) return toInworldLanguage(trimmed) ?? trimmed
  const parts = trimmed.split("_")
  if (parts.length >= 2 && /^[A-Za-z]{2,3}$/.test(parts[0] ?? "")) {
    return `${parts[0]!.toLowerCase()}-${parts.slice(1).join("-")}`
  }
  return toInworldLanguage(trimmed)
}

export function safeInworldLangFilterValue(language: string): string | undefined {
  const mapped = toInworldLanguage(language)
  if (mapped && SAFE_LANG_FILTER.test(mapped)) return mapped
  return undefined
}

/** AIP-160 filter: system voices whose primary language matches any lane. */
export function buildListVoicesFilter(languages: readonly string[]): string | null {
  const codes = [...new Set(
    languages.map(safeInworldLangFilterValue).filter((c): c is string => Boolean(c)),
  )]
  if (codes.length === 0) return null
  const lang = codes.map((c) => `lang_code = "${c}"`).join(" OR ")
  const source = `source = "SYSTEM"`
  return codes.length === 1 ? `${source} AND ${lang}` : `${source} AND (${lang})`
}

export function bytesToBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes)
  const chunk = 0x8000
  let binary = ""
  for (let i = 0; i < u8.length; i += chunk) {
    const slice = u8.subarray(i, i + chunk)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** Duration of a LINEAR16 WAV (Inworld non-streaming includes the header). */
export function wavDurationSeconds(bytes: ArrayBuffer): number {
  if (bytes.byteLength < 12) return 0
  const view = new DataView(bytes)
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    )
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    return bytes.byteLength / (24000 * 2)
  }
  let offset = 12
  let byteRate = 0
  let dataSize = 0
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    if (id === "fmt " && offset + 20 <= view.byteLength) {
      byteRate = view.getUint32(offset + 16, true)
    } else if (id === "data") {
      dataSize = size
    }
    offset += 8 + size + (size % 2)
  }
  if (byteRate > 0 && dataSize > 0) return dataSize / byteRate
  return 0
}

function cloneDisplayName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_")
  const trimmed = cleaned.replace(/^_+|_+$/g, "") || "clone"
  return `aq_${trimmed}`.slice(0, 60)
}

async function readInworldError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "")
  const trimmed = text.trim()
  if (!trimmed) return `HTTP ${res.status}`
  try {
    const json = JSON.parse(trimmed) as { message?: string; error?: string }
    return json.message || json.error || trimmed.slice(0, 500)
  } catch {
    return trimmed.slice(0, 500)
  }
}

export async function cloneInworldVoice(
  config: InworldTtsConfig,
  args: CloneInworldArgs,
): Promise<string> {
  const languageCode = toInworldLanguage(args.language)
  const body: Record<string, unknown> = {
    displayName: cloneDisplayName(args.displayName),
    voiceSamples: [{ audioData: bytesToBase64(args.audioBytes) }],
    audioProcessingConfig: { removeBackgroundNoise: true },
  }
  if (languageCode) body.languageCode = languageCode

  let res: Response
  try {
    res = await fetch(`${inworldApiBase(config)}/voices/v1/voices:clone`, {
      method: "POST",
      headers: {
        Authorization: inworldAuthHeader(config.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`Inworld clone unreachable: ${String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`Inworld clone failed (${res.status}): ${await readInworldError(res)}`)
  }
  const json = (await res.json()) as { voice?: { voiceId?: string }; voiceId?: string }
  const voiceId = json.voice?.voiceId ?? json.voiceId
  if (!voiceId) throw new Error("Inworld clone returned no voiceId")
  return voiceId
}

export function parseInworldDesignPromptMode(
  value: unknown,
): "DESIGN_PROMPT_MODE_ASSISTED" | "DESIGN_PROMPT_MODE_VERBATIM" | undefined {
  if (value === INWORLD_DESIGN_PROMPT_MODE_VERBATIM) return INWORLD_DESIGN_PROMPT_MODE_VERBATIM
  if (value === INWORLD_DESIGN_PROMPT_MODE_ASSISTED) return INWORLD_DESIGN_PROMPT_MODE_ASSISTED
  return undefined
}

export function clampInworldDesignSamples(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(n)) return INWORLD_DESIGN_SAMPLE_COUNT
  return Math.min(3, Math.max(1, Math.round(n)))
}

export function encodeInworldVoiceId(voiceId: string): string {
  return encodeURIComponent(voiceId.trim())
}

export async function designInworldVoice(
  config: InworldTtsConfig,
  args: DesignInworldVoiceArgs,
): Promise<InworldDesignedPreview[]> {
  const designPrompt = args.designPrompt.trim()
  if (designPrompt.length < INWORLD_DESIGN_PROMPT_MIN || designPrompt.length > INWORLD_DESIGN_PROMPT_MAX) {
    throw new Error(
      `design prompt must be ${INWORLD_DESIGN_PROMPT_MIN}–${INWORLD_DESIGN_PROMPT_MAX} characters`,
    )
  }
  const previewText = args.previewText?.trim() || INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT
  const languageCode = toInworldLanguage(args.language)
  const body: Record<string, unknown> = {
    designPrompt,
    previewText,
    voiceDesignConfig: { numberOfSamples: clampInworldDesignSamples(args.numberOfSamples) },
  }
  if (languageCode) body.languageCode = languageCode
  const designPromptMode = parseInworldDesignPromptMode(args.designPromptMode)
  if (designPromptMode === INWORLD_DESIGN_PROMPT_MODE_VERBATIM) {
    body.designPromptMode = designPromptMode
  }

  let res: Response
  try {
    res = await fetch(`${inworldApiBase(config)}/voices/v1/voices:design`, {
      method: "POST",
      headers: {
        Authorization: inworldAuthHeader(config.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`Inworld voice design unreachable: ${String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`Inworld voice design failed (${res.status}): ${await readInworldError(res)}`)
  }
  const json = (await res.json()) as {
    previewVoices?: Array<{ voiceId?: string; previewText?: string; previewAudio?: string }>
  }
  const previews: InworldDesignedPreview[] = []
  for (const row of json.previewVoices ?? []) {
    const voiceId = row.voiceId?.trim()
    const previewAudio = row.previewAudio?.trim()
    if (!voiceId || !previewAudio) continue
    previews.push({
      voiceId,
      previewText: row.previewText?.trim() || previewText,
      previewAudio,
    })
  }
  if (previews.length === 0) throw new Error("Inworld voice design returned no previews")
  return previews
}

export async function publishInworldVoice(
  config: InworldTtsConfig,
  args: PublishInworldVoiceArgs,
): Promise<string> {
  const voiceId = args.voiceId.trim()
  if (!voiceId) throw new Error("missing voiceId")
  const displayName = args.displayName.trim().slice(0, 100) || "Designed voice"
  const body: Record<string, unknown> = { displayName }
  const description = args.description?.trim()
  if (description) body.description = description.slice(0, 1000)

  let res: Response
  try {
    res = await fetch(
      `${inworldApiBase(config)}/voices/v1/voices/${encodeInworldVoiceId(voiceId)}:publish`,
      {
        method: "POST",
        headers: {
          Authorization: inworldAuthHeader(config.apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    )
  } catch (err) {
    throw new Error(`Inworld voice publish unreachable: ${String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`Inworld voice publish failed (${res.status}): ${await readInworldError(res)}`)
  }
  const json = (await res.json()) as { voice?: { voiceId?: string }; voiceId?: string }
  return json.voice?.voiceId ?? json.voiceId ?? voiceId
}

export function parseInworldAudioQuality(value: unknown): "standard" | "highest" | undefined {
  return value === "standard" || value === "highest" ? value : undefined
}

export function parseInworldDeliveryMode(value: unknown): "STABLE" | "BALANCED" | "CREATIVE" | undefined {
  return value === "STABLE" || value === "BALANCED" || value === "CREATIVE" ? value : undefined
}

export function clampInworldSpeakingRate(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(n)) return undefined
  const clamped = Math.min(INWORLD_SPEAKING_RATE_MAX, Math.max(INWORLD_SPEAKING_RATE_MIN, n))
  return Math.round(clamped * 100) / 100
}

/** Per-voice quality wins over the worker's INWORLD_TTS_MODEL override. */
export function resolveInworldModelId(
  audioQuality: unknown,
  configModelId?: string,
): string {
  const quality = parseInworldAudioQuality(audioQuality)
  if (quality === "highest") return INWORLD_TTS_MODEL_HIGHEST
  if (quality === "standard") return DEFAULT_INWORLD_TTS_MODEL
  return configModelId?.trim() || INWORLD_TTS_MODEL_HIGHEST
}

export function isInworldTts2Model(modelId: string): boolean {
  return modelId === INWORLD_TTS_MODEL_HIGHEST
}

export async function synthesizeInworldSpeech(
  config: InworldTtsConfig,
  args: SynthesizeInworldArgs,
): Promise<SynthesizeInworldResult> {
  const language = toInworldLanguage(args.language)
  const modelId = resolveInworldModelId(args.audioQuality, config.modelId)
  const speakingRate = clampInworldSpeakingRate(args.speakingRate)
  const audioConfig: Record<string, unknown> = {
    audioEncoding: "LINEAR16",
    sampleRateHertz: 24000,
  }
  if (speakingRate !== undefined && speakingRate !== 1) {
    audioConfig.speakingRate = speakingRate
  }
  const payload: Record<string, unknown> = {
    text: args.text,
    voiceId: args.voiceId?.trim() || config.defaultVoiceId || DEFAULT_INWORLD_VOICE,
    modelId,
    audioConfig,
  }
  if (language) payload.language = language
  if (isInworldTts2Model(modelId)) {
    payload.deliveryMode = parseInworldDeliveryMode(args.deliveryMode) ?? DEFAULT_INWORLD_DELIVERY_MODE
  }

  let res: Response
  try {
    res = await fetch(`${inworldApiBase(config)}/tts/v1/voice`, {
      method: "POST",
      headers: {
        Authorization: inworldAuthHeader(config.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(INWORLD_TTS_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // AQU-1156: a hung upstream used to hold this subrequest open until the
    // platform killed it, so the caller's generate control spun forever with
    // no audio and no error. The deadline turns that into a 502 the client can
    // show and the user can retry.
    if (isAbortTimeout(err)) {
      throw new Error(
        `Inworld TTS did not respond within ${Math.round(INWORLD_TTS_REQUEST_TIMEOUT_MS / 1000)}s`,
      )
    }
    throw new Error(`Inworld TTS unreachable: ${String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`Inworld TTS failed (${res.status}): ${await readInworldError(res)}`)
  }
  const json = (await res.json()) as {
    audioContent?: string
    timestampInfo?: { wordAlignment?: { wordEndTimeSeconds?: number[] } }
  }
  if (!json.audioContent) throw new Error("Inworld TTS returned no audioContent")
  const wavBytes = base64ToBytes(json.audioContent)
  const wordEnds = json.timestampInfo?.wordAlignment?.wordEndTimeSeconds
  const fromTimestamps =
    Array.isArray(wordEnds) && wordEnds.length > 0 ? Number(wordEnds[wordEnds.length - 1]) : NaN
  const durationSeconds = Number.isFinite(fromTimestamps) && fromTimestamps > 0
    ? fromTimestamps
    : wavDurationSeconds(wavBytes)
  return { wavBytes, durationSeconds }
}

export async function listInworldVoices(
  config: InworldTtsConfig,
  languages: readonly string[],
  opts?: { allSystem?: boolean },
): Promise<InworldCatalogVoice[]> {
  const filter = opts?.allSystem
    ? `source = "SYSTEM"`
    : buildListVoicesFilter(languages)
  if (!filter) return []

  const voices: InworldCatalogVoice[] = []
  const seen = new Set<string>()
  let pageToken = ""
  for (let page = 0; page < LIST_VOICES_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      filter,
      pageSize: String(LIST_VOICES_PAGE_SIZE),
      orderBy: "display_name",
    })
    if (pageToken) params.set("pageToken", pageToken)

    let res: Response
    try {
      res = await fetch(`${inworldApiBase(config)}/voices/v1/voices?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: inworldAuthHeader(config.apiKey) },
      })
    } catch (err) {
      throw new Error(`Inworld voices unreachable: ${String(err)}`)
    }
    if (!res.ok) {
      throw new Error(`Inworld list voices failed (${res.status}): ${await readInworldError(res)}`)
    }
    const json = (await res.json()) as {
      voices?: Array<{
        voiceId?: string
        displayName?: string
        langCode?: string
        languageCode?: string
        description?: string
      }>
      nextPageToken?: string
    }
    for (const row of json.voices ?? []) {
      const voiceId = row.voiceId?.trim()
      if (!voiceId || seen.has(voiceId)) continue
      seen.add(voiceId)
      const language = inworldLangCodeToBcp47(row.langCode ?? row.languageCode) ?? "und"
      voices.push({
        voiceId,
        displayName: row.displayName?.trim() || voiceId,
        language,
        ...(row.description?.trim() ? { description: row.description.trim() } : {}),
      })
    }
    pageToken = json.nextPageToken?.trim() ?? ""
    if (!pageToken) break
  }
  return voices
}
