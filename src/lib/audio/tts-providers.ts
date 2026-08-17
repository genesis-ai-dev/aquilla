import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import { HAS_HOSTED_MMS_MODELS, USE_SHERPA_MMS_MODELS, isSupportedMmsLanguageCode } from "./mms-languages"
import type { MessageKey } from "@/lib/i18n/messages/en"

export const DEFAULT_TTS_PROVIDER: TtsProvider = "omnivoice"

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
export const DEFAULT_KOKORO_VOICE = "af_heart"
export const DEFAULT_MMS_LANGUAGE = "eng"

export interface TtsProviderInfo {
  id: TtsProvider
  // `title` stays plain, untranslated English by design — it's the engine's
  // display name (e.g. "OmniVoice", "Gemini TTS"), and its one consumer
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
    hintKey: "audio.provider.omnivoiceHint",
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
