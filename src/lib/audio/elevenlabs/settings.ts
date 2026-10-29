// ElevenLabs engine defaults and pure helpers (AQU-2299).
//
// Kept apart from the network client so tts-providers.ts / change-voice.ts can
// import them without pulling fetch code into every voice surface.

import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ElevenLabsVoiceSettings, Voice } from "@/lib/parsers/types"

export const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2"
/** The speech-to-speech model Change voice uses (POST /v1/voice-changer). */
export const ELEVENLABS_STS_MODEL = "eleven_multilingual_sts_v2"

/** The API's documented defaults (text-to-speech/convert `voice_settings`). */
export const DEFAULT_ELEVENLABS_SETTINGS: ElevenLabsVoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1,
  speakerBoost: true,
}

/** Speed's documented range; the other sliders are 0–1. */
export const ELEVENLABS_SPEED_MIN = 0.7
export const ELEVENLABS_SPEED_MAX = 1.2

export interface ElevenLabsModelOption {
  id: string
  /** ElevenLabs' own product name — not translated. */
  name: string
  descriptionKey: MessageKey
}

/** Curated TTS models, in picker order. Mirrors ELEVENLABS_TTS_MODELS in
 *  sync-worker/src/elevenlabs-api.ts, which filters them to the account. */
export const ELEVENLABS_MODELS: readonly ElevenLabsModelOption[] = [
  { id: "eleven_multilingual_v2", name: "Multilingual v2", descriptionKey: "audio.elevenLabs.modelMultilingualV2" },
  { id: "eleven_v3", name: "Eleven v3", descriptionKey: "audio.elevenLabs.modelV3" },
  { id: "eleven_flash_v2_5", name: "Flash v2.5", descriptionKey: "audio.elevenLabs.modelFlash" },
]

/** ElevenLabs recommends a minute or two of clean speech for an instant clone. */
export const ELEVENLABS_CLONE_MIN_SECONDS = 10
export const ELEVENLABS_CLONE_RECOMMENDED_SECONDS = 60
export const ELEVENLABS_CLONE_MAX_CLIPS = 25

/** The sample line Preview speaks. Short on purpose: it spends the user's characters. */
export const ELEVENLABS_PREVIEW_TEXT_MAX = 300

/** Conversion fingerprint key — mirrors `elevenLabsVoiceKey` in sync-worker/src/elevenlabs.ts. */
export function elevenLabsConversionKey(voiceId: string): string {
  return `elevenlabs:${voiceId}`
}

export function isElevenLabsVoice(voice: Pick<Voice, "provider" | "elevenLabs">): boolean {
  return voice.provider === "elevenlabs" && Boolean(voice.elevenLabs?.voiceId)
}

/** A voice's settings with every missing knob at its default. */
export function elevenLabsSettingsOf(voice: Pick<Voice, "elevenLabs">): ElevenLabsVoiceSettings {
  return { ...DEFAULT_ELEVENLABS_SETTINGS, ...(voice.elevenLabs?.settings ?? {}) }
}

/**
 * ISO 639-1 code ElevenLabs' `language_code` accepts, from a lane's BCP-47
 * language ("es-419" → "es"). Undefined for anything else; the worker also
 * drops it for Multilingual v2, which detects the language itself.
 */
export function elevenLabsLanguageCode(language: string | undefined): string | undefined {
  const base = language?.trim().toLowerCase().split(/[-_]/)[0]
  return base && /^[a-z]{2}$/.test(base) ? base : undefined
}
