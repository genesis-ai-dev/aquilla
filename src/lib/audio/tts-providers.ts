import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import { HAS_HOSTED_MMS_MODELS, USE_SHERPA_MMS_MODELS, isSupportedMmsLanguageCode } from "./mms-languages"

export const DEFAULT_TTS_PROVIDER: TtsProvider = "omnivoice"

export const GEMINI_TTS_VOICES: readonly { name: string; description: string }[] = [
  { name: "Zephyr", description: "Bright" },
  { name: "Puck", description: "Upbeat" },
  { name: "Charon", description: "Informative" },
  { name: "Kore", description: "Firm" },
  { name: "Fenrir", description: "Excitable" },
  { name: "Leda", description: "Youthful" },
  { name: "Orus", description: "Firm" },
  { name: "Aoede", description: "Breezy" },
  { name: "Callirrhoe", description: "Easy-going" },
  { name: "Autonoe", description: "Bright" },
  { name: "Enceladus", description: "Breathy" },
  { name: "Iapetus", description: "Clear" },
  { name: "Umbriel", description: "Easy-going" },
  { name: "Algieba", description: "Smooth" },
  { name: "Despina", description: "Smooth" },
  { name: "Erinome", description: "Clear" },
  { name: "Algenib", description: "Gravelly" },
  { name: "Rasalgethi", description: "Informative" },
  { name: "Laomedeia", description: "Upbeat" },
  { name: "Achernar", description: "Soft" },
  { name: "Alnilam", description: "Firm" },
  { name: "Schedar", description: "Even" },
  { name: "Gacrux", description: "Mature" },
  { name: "Pulcherrima", description: "Forward" },
  { name: "Achird", description: "Friendly" },
  { name: "Zubenelgenubi", description: "Casual" },
  { name: "Vindemiatrix", description: "Gentle" },
  { name: "Sadachbia", description: "Lively" },
  { name: "Sadaltager", description: "Knowledgeable" },
  { name: "Sulafat", description: "Warm" },
] as const

export const DEFAULT_GEMINI_VOICE = "Kore"
export const DEFAULT_KOKORO_VOICE = "af_heart"
export const DEFAULT_MMS_LANGUAGE = "eng"

export interface TtsProviderInfo {
  id: TtsProvider
  title: string
  shortTitle: string
  hint: string
  /** Where the engine runs. Drives the Cloud/On-device grouping in the picker. */
  tier: "cloud" | "device"
  /** Whether a reference recording can clone a target timbre for this engine. */
  supportsCloning: boolean
  /** Whether the engine exposes named base voices (false for OmniVoice). */
  hasNamedVoices: boolean
  /** A few words of value-prop for the engine card. */
  blurb: string
  /** Short caveat shown under the blurb (key needed, performance, etc.). */
  caveat?: string
  /** Optional external info page; only set when a real page exists. */
  learnMoreUrl?: string
  badge?: string
  localModel?: "kokoro" | "mms"
  requiresGeminiKey?: boolean
}

export const TTS_PROVIDER_INFOS: readonly TtsProviderInfo[] = [
  {
    id: "omnivoice",
    title: "OmniVoice",
    shortTitle: "OmniVoice",
    tier: "cloud",
    supportsCloning: true,
    hasNamedVoices: false,
    badge: "Recommended",
    blurb: "Hosted neural voice — no setup or API key.",
    hint: "Runs on our servers. No key or download; usage is cloud-metered. Supports voice cloning from a reference recording.",
  },
  {
    id: "gemini",
    title: "Gemini TTS",
    shortTitle: "Gemini",
    tier: "cloud",
    supportsCloning: true,
    hasNamedVoices: true,
    requiresGeminiKey: true,
    blurb: "Highest quality, promptable; many languages.",
    caveat: "Needs your own Google AI key.",
    hint: "BYOK Google AI key. Promptable, high-quality voices.",
  },
  {
    id: "kokoro",
    title: "Kokoro (local)",
    shortTitle: "Kokoro",
    tier: "device",
    supportsCloning: false,
    hasNamedVoices: true,
    localModel: "kokoro",
    blurb: "Free, on-device English voices.",
    caveat: "One-time download; may affect performance.",
    hint: "Runs in-browser after a one-time local model download.",
  },
  {
    id: "mms",
    title: "MMS (multilingual)",
    shortTitle: "MMS",
    tier: "device",
    supportsCloning: false,
    hasNamedVoices: true,
    localModel: "mms",
    blurb: "Free, on-device; many languages.",
    caveat: "One model per language; may affect performance.",
    hint: USE_SHERPA_MMS_MODELS
      ? "Local browser voices loaded from the Sherpa-ONNX MMS mirror."
      : HAS_HOSTED_MMS_MODELS
        ? "Local browser voices loaded from the hosted MMS model bucket."
        : "Local browser voices for supported MMS language repos.",
  },
] as const

const GEMINI_VOICE_NAMES = new Set(GEMINI_TTS_VOICES.map((v) => v.name.toLowerCase()))

const ISO_639_TO_MMS: Record<string, string> = {
  ar: "ara", ara: "ara",
  de: "deu", deu: "deu", ger: "deu",
  en: "eng", eng: "eng",
  es: "spa", spa: "spa",
  fr: "fra", fra: "fra", fre: "fra",
  hi: "hin", hin: "hin",
  ko: "kor", kor: "kor",
  pt: "por", por: "por",
  ro: "ron", ron: "ron",
  ru: "rus", rus: "rus",
  vi: "vie", vie: "vie",
  yo: "yor", yor: "yor",
}

export function providerInfo(provider: TtsProvider | undefined): TtsProviderInfo {
  return TTS_PROVIDER_INFOS.find((p) => p.id === provider) ?? TTS_PROVIDER_INFOS[0]
}

export function resolveTtsProvider(settings: ProjectTtsSettings | undefined): TtsProvider {
  return settings?.provider ?? DEFAULT_TTS_PROVIDER
}

export function isGeminiVoiceName(value: string | undefined): boolean {
  return Boolean(value && GEMINI_VOICE_NAMES.has(value.trim().toLowerCase()))
}

export function isKokoroVoiceName(value: string | undefined): boolean {
  return Boolean(value && /^[a-z]{2}_[a-z0-9_]+$/i.test(value.trim()))
}

export function isMmsLanguageCode(value: string | undefined): boolean {
  return isSupportedMmsLanguageCode(value)
}

export function inferMmsLanguageCode(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (isSupportedMmsLanguageCode(normalized)) return normalized
  const key = normalized.split(/[-_]/)[0]
  if (!key) return undefined
  const mapped = ISO_639_TO_MMS[normalized] ?? ISO_639_TO_MMS[key]
  return isSupportedMmsLanguageCode(mapped) ? mapped : undefined
}

export function defaultVoiceNameForProvider(
  provider: TtsProvider,
  context: { targetLanguage?: string } = {},
): string {
  if (provider === "omnivoice") return ""
  if (provider === "kokoro") return DEFAULT_KOKORO_VOICE
  if (provider === "mms") return inferMmsLanguageCode(context.targetLanguage) ?? DEFAULT_MMS_LANGUAGE
  return DEFAULT_GEMINI_VOICE
}

export function normalizeVoiceForProvider(
  voice: Voice,
  provider: TtsProvider,
  context: { targetLanguage?: string } = {},
): Voice {
  const next: Voice = { ...voice, provider }
  if (provider === "omnivoice") {
    next.voiceName = ""
    return next
  }
  if (provider === "gemini") {
    if (!isGeminiVoiceName(next.voiceName)) next.voiceName = DEFAULT_GEMINI_VOICE
    return next
  }
  if (provider === "kokoro") {
    if (!isKokoroVoiceName(next.voiceName)) next.voiceName = DEFAULT_KOKORO_VOICE
    return next
  }
  next.voiceName =
    inferMmsLanguageCode(next.voiceName) ??
    inferMmsLanguageCode(context.targetLanguage) ??
    DEFAULT_MMS_LANGUAGE
  return next
}

export function ttsProviderModel(provider: TtsProvider): "kokoro" | "mms" | null {
  return providerInfo(provider).localModel ?? null
}
