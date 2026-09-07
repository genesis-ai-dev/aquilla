import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import { HAS_HOSTED_MMS_MODELS, USE_SHERPA_MMS_MODELS, isSupportedMmsLanguageCode } from "./mms-languages"
import { defaultKokoroVoiceForLanguage, isBundledKokoroVoiceName } from "./kokoro-languages"
import type { MessageKey } from "@/lib/i18n/messages/en"

export const DEFAULT_TTS_PROVIDER: TtsProvider = "inworld"

// `descriptionKey` — not `description` — because this table is module scope:
// `t()` resolves the active locale at CALL time (src/lib/i18n/standalone.ts),
// so calling it here would freeze whatever locale was active at import and
// never update. Resolve with `t(voice.descriptionKey)` at the render site
// instead. `name` (Google's own proper noun for the voice) is never
// translated. Several voices share one description verbatim — that's Google's
// own catalog, not a copy-paste — so several rows share one descriptionKey.
export const GEMINI_TTS_VOICES: readonly { name: string; descriptionKey: MessageKey }[] = [
  { name: "Zephyr", descriptionKey: "audio.voice.bright" },
  { name: "Puck", descriptionKey: "audio.voice.upbeat" },
  { name: "Charon", descriptionKey: "audio.voice.informative" },
  { name: "Kore", descriptionKey: "audio.voice.firm" },
  { name: "Fenrir", descriptionKey: "audio.voice.excitable" },
  { name: "Leda", descriptionKey: "audio.voice.youthful" },
  { name: "Orus", descriptionKey: "audio.voice.firm" },
  { name: "Aoede", descriptionKey: "audio.voice.breezy" },
  { name: "Callirrhoe", descriptionKey: "audio.voice.easyGoing" },
  { name: "Autonoe", descriptionKey: "audio.voice.bright" },
  { name: "Enceladus", descriptionKey: "audio.voice.breathy" },
  { name: "Iapetus", descriptionKey: "audio.voice.clear" },
  { name: "Umbriel", descriptionKey: "audio.voice.easyGoing" },
  { name: "Algieba", descriptionKey: "audio.voice.smooth" },
  { name: "Despina", descriptionKey: "audio.voice.smooth" },
  { name: "Erinome", descriptionKey: "audio.voice.clear" },
  { name: "Algenib", descriptionKey: "audio.voice.gravelly" },
  { name: "Rasalgethi", descriptionKey: "audio.voice.informative" },
  { name: "Laomedeia", descriptionKey: "audio.voice.upbeat" },
  { name: "Achernar", descriptionKey: "audio.voice.soft" },
  { name: "Alnilam", descriptionKey: "audio.voice.firm" },
  { name: "Schedar", descriptionKey: "audio.voice.even" },
  { name: "Gacrux", descriptionKey: "audio.voice.mature" },
  { name: "Pulcherrima", descriptionKey: "audio.voice.forward" },
  { name: "Achird", descriptionKey: "audio.voice.friendly" },
  { name: "Zubenelgenubi", descriptionKey: "audio.voice.casual" },
  { name: "Vindemiatrix", descriptionKey: "audio.voice.gentle" },
  { name: "Sadachbia", descriptionKey: "audio.voice.lively" },
  { name: "Sadaltager", descriptionKey: "audio.voice.knowledgeable" },
  { name: "Sulafat", descriptionKey: "audio.voice.warm" },
] as const

export const DEFAULT_GEMINI_VOICE = "Kore"
export { DEFAULT_KOKORO_VOICE } from "./kokoro-languages"
export const DEFAULT_MMS_LANGUAGE = "eng"

/** Inworld stock voices used as the hosted default catalog (AQU-1189).
 *  Clone IDs from Instant Voice Cloning are accepted separately — they contain `__`. */
export const INWORLD_TTS_VOICES: readonly { name: string; descriptionKey: MessageKey }[] = [
  { name: "Dennis", descriptionKey: "audio.voice.warm" },
  { name: "Sarah", descriptionKey: "audio.voice.friendly" },
  { name: "Ashley", descriptionKey: "audio.voice.bright" },
  { name: "Deborah", descriptionKey: "audio.voice.mature" },
  { name: "Edward", descriptionKey: "audio.voice.firm" },
  { name: "Hana", descriptionKey: "audio.voice.gentle" },
  { name: "Olivia", descriptionKey: "audio.voice.clear" },
  { name: "Priya", descriptionKey: "audio.voice.lively" },
] as const
export const DEFAULT_INWORLD_VOICE = "Dennis"
export const INWORLD_TTS_MODEL = "inworld-tts-2-flash"

export interface TtsProviderInfo {
  id: TtsProvider
  // `title` stays plain, untranslated English by design — it's the engine's
  // display name (e.g. "Inworld TTS", "Gemini TTS"), and its one consumer
  // (NewVoiceModal's audio.newVoice.singleVoiceHint placeholder) is documented
  // to keep it "already resolved in English by the app — a brand name, do not
  // translate the substituted value." shortTitle is likewise a display name.
  title: string
  shortTitle: string
  /** `hintKey` — see the GEMINI_TTS_VOICES comment above for why this table
   *  stores a MessageKey rather than calling `t()` at module scope. */
  hintKey: MessageKey
  /** Where the engine runs. Drives the Cloud/On-device grouping in the picker. */
  tier: "cloud" | "device"
  /** Whether a reference recording can clone a target timbre for this engine. */
  supportsCloning: boolean
  /** Whether the engine exposes named base voices. */
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
    id: "inworld",
    title: "Inworld TTS",
    shortTitle: "Inworld",
    tier: "cloud",
    supportsCloning: true,
    hasNamedVoices: true,
    badge: "Recommended",
    blurb: "Hosted Inworld TTS 2 Flash — multilingual, clone from a reference clip.",
    hintKey: "audio.provider.inworldHint",
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
    hintKey: "audio.provider.geminiHint",
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
    hintKey: "audio.provider.kokoroHint",
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
    hintKey: USE_SHERPA_MMS_MODELS
      ? "audio.provider.mmsHintSherpa"
      : HAS_HOSTED_MMS_MODELS
        ? "audio.provider.mmsHintHosted"
        : "audio.provider.mmsHintFallback",
  },
] as const

const GEMINI_VOICE_NAMES = new Set(GEMINI_TTS_VOICES.map((v) => v.name.toLowerCase()))
const INWORLD_VOICE_NAMES = new Set(INWORLD_TTS_VOICES.map((v) => v.name.toLowerCase()))

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

/**
 * Legacy OmniVoice ids persist on existing projects/voices. Runtime treats them
 * as Inworld so commercial orgs never hit the CC-BY-NC Modal path (AQU-1189).
 */
export function effectiveTtsProvider(provider: TtsProvider | undefined): TtsProvider {
  if (!provider || provider === "omnivoice") return DEFAULT_TTS_PROVIDER
  return provider
}

export function isServerTtsProvider(provider: TtsProvider | undefined): boolean {
  return effectiveTtsProvider(provider) === "inworld"
}

export function providerInfo(provider: TtsProvider | undefined): TtsProviderInfo {
  const id = effectiveTtsProvider(provider)
  return TTS_PROVIDER_INFOS.find((p) => p.id === id) ?? TTS_PROVIDER_INFOS[0]
}

export function resolveTtsProvider(settings: ProjectTtsSettings | undefined): TtsProvider {
  return effectiveTtsProvider(settings?.provider)
}

export function isGeminiVoiceName(value: string | undefined): boolean {
  return Boolean(value && GEMINI_VOICE_NAMES.has(value.trim().toLowerCase()))
}

export function isInworldVoiceName(value: string | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  // Live catalog ids (Alex, Dennis, …) must not steal Gemini/Kokoro/MMS knobs.
  if (isGeminiVoiceName(trimmed) || isKokoroVoiceName(trimmed) || isMmsLanguageCode(trimmed)) {
    return false
  }
  if (INWORLD_VOICE_NAMES.has(trimmed.toLowerCase())) return true
  // Instant Voice Cloning ids look like `workspace__display_timestamp`.
  if (trimmed.includes("__")) return true
  return /^[A-Za-z][\w-]{0,127}$/.test(trimmed)
}

export function isKokoroVoiceName(value: string | undefined): boolean {
  return isBundledKokoroVoiceName(value)
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
  const engine = effectiveTtsProvider(provider)
  if (engine === "inworld") return DEFAULT_INWORLD_VOICE
  if (engine === "kokoro") return defaultKokoroVoiceForLanguage(context.targetLanguage)
  if (engine === "mms") return inferMmsLanguageCode(context.targetLanguage) ?? DEFAULT_MMS_LANGUAGE
  return DEFAULT_GEMINI_VOICE
}

export function normalizeVoiceForProvider(
  voice: Voice,
  provider: TtsProvider,
  context: { targetLanguage?: string } = {},
): Voice {
  const engine = effectiveTtsProvider(provider)
  const next: Voice = { ...voice, provider: engine }
  if (engine === "inworld") {
    if (!isInworldVoiceName(next.voiceName)) next.voiceName = DEFAULT_INWORLD_VOICE
    return next
  }
  delete next.language
  if (engine === "gemini") {
    if (!isGeminiVoiceName(next.voiceName)) next.voiceName = DEFAULT_GEMINI_VOICE
    return next
  }
  if (engine === "kokoro") {
    if (!isKokoroVoiceName(next.voiceName)) {
      next.voiceName = defaultKokoroVoiceForLanguage(context.targetLanguage)
    }
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
