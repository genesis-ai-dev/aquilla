// Inworld TTS 2 Flash client used by POST /api/v1/voice/tts.
//
// Official REST (https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech):
//   POST https://api.inworld.ai/tts/v1/voice
//   Authorization: Basic $INWORLD_API_KEY
//   { text, voiceId, modelId: "inworld-tts-2-flash", audioConfig, language? }
// Instant clone (https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice):
//   POST https://api.inworld.ai/voices/v1/voices:clone
//   { displayName, languageCode?, voiceSamples: [{ audioData: base64 }] }
//
// AQU-1189: this is the commercial replacement for Modal OmniVoice (CC-BY-NC weights).

export const DEFAULT_INWORLD_API_BASE = "https://api.inworld.ai"
export const DEFAULT_INWORLD_TTS_MODEL = "inworld-tts-2-flash"
export const DEFAULT_INWORLD_VOICE = "Dennis"
export const INWORLD_MAX_TEXT_CHARS = 2000

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

/** Map project language tags (eng, en, en-US, EN_GB) onto Inworld's BCP-47. */
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
  if (/^[a-z]{2}(-[a-z0-9]+)*$/i.test(normalized)) return normalized
  return undefined
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

export async function synthesizeInworldSpeech(
  config: InworldTtsConfig,
  args: SynthesizeInworldArgs,
): Promise<SynthesizeInworldResult> {
  const language = toInworldLanguage(args.language)
  const payload: Record<string, unknown> = {
    text: args.text,
    voiceId: args.voiceId?.trim() || config.defaultVoiceId || DEFAULT_INWORLD_VOICE,
    modelId: config.modelId?.trim() || DEFAULT_INWORLD_TTS_MODEL,
    audioConfig: {
      audioEncoding: "LINEAR16",
      sampleRateHertz: 24000,
    },
  }
  if (language) payload.language = language

  let res: Response
  try {
    res = await fetch(`${inworldApiBase(config)}/tts/v1/voice`, {
      method: "POST",
      headers: {
        Authorization: inworldAuthHeader(config.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
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
