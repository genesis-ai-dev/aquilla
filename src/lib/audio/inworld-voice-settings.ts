// Per-voice Inworld playground knobs (AQU-1189).
//
// Maps the TTS Playground controls onto the synthesize-speech API:
//   Audio quality  → modelId  (standard = inworld-tts-2-flash, highest = inworld-tts-2)
//   Delivery       → deliveryMode (STABLE | BALANCED | CREATIVE; TTS-2 only)
//   Talking speed  → audioConfig.speakingRate in [0.5, 1.5]
//
// Flash ignores deliveryMode; the picker disables that slider until Highest.

import type { Voice } from "@/lib/parsers/types"

export const INWORLD_TTS_MODEL_STANDARD = "inworld-tts-2-flash"
export const INWORLD_TTS_MODEL_HIGHEST = "inworld-tts-2"

export const INWORLD_SPEAKING_RATE_MIN = 0.5
export const INWORLD_SPEAKING_RATE_MAX = 1.5
export const INWORLD_SPEAKING_RATE_DEFAULT = 1
export const INWORLD_SPEAKING_RATE_STEP = 0.05

export const INWORLD_DELIVERY_MODES = ["STABLE", "BALANCED", "CREATIVE"] as const
export type InworldDeliveryMode = (typeof INWORLD_DELIVERY_MODES)[number]
export const DEFAULT_INWORLD_DELIVERY_MODE: InworldDeliveryMode = "STABLE"

export const INWORLD_AUDIO_QUALITIES = ["standard", "highest"] as const
export type InworldAudioQuality = (typeof INWORLD_AUDIO_QUALITIES)[number]
export const DEFAULT_INWORLD_AUDIO_QUALITY: InworldAudioQuality = "standard"

export type InworldSynthFields = {
  speakingRate?: number
  deliveryMode?: InworldDeliveryMode
  audioQuality?: InworldAudioQuality
}

export function isInworldDeliveryMode(value: unknown): value is InworldDeliveryMode {
  return value === "STABLE" || value === "BALANCED" || value === "CREATIVE"
}

export function isInworldAudioQuality(value: unknown): value is InworldAudioQuality {
  return value === "standard" || value === "highest"
}

export function clampInworldSpeakingRate(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(n)) return undefined
  const clamped = Math.min(INWORLD_SPEAKING_RATE_MAX, Math.max(INWORLD_SPEAKING_RATE_MIN, n))
  return Math.round(clamped * 100) / 100
}

export function formatInworldSpeakingRate(rate: number): string {
  const rounded = clampInworldSpeakingRate(rate) ?? INWORLD_SPEAKING_RATE_DEFAULT
  const text = rounded.toFixed(2).replace(/\.?0+$/, "")
  return `${text}x`
}

export function inworldDeliveryIndex(mode: InworldDeliveryMode | undefined): number {
  const idx = INWORLD_DELIVERY_MODES.indexOf(mode ?? DEFAULT_INWORLD_DELIVERY_MODE)
  return idx >= 0 ? idx : 0
}

export function inworldDeliveryModeAt(index: number): InworldDeliveryMode {
  return INWORLD_DELIVERY_MODES[Math.min(2, Math.max(0, Math.round(index)))] ?? DEFAULT_INWORLD_DELIVERY_MODE
}

export function effectiveInworldAudioQuality(voice: Pick<Voice, "audioQuality">): InworldAudioQuality {
  return isInworldAudioQuality(voice.audioQuality) ? voice.audioQuality : DEFAULT_INWORLD_AUDIO_QUALITY
}

export function effectiveInworldDeliveryMode(voice: Pick<Voice, "deliveryMode">): InworldDeliveryMode {
  return isInworldDeliveryMode(voice.deliveryMode) ? voice.deliveryMode : DEFAULT_INWORLD_DELIVERY_MODE
}

export function effectiveInworldSpeakingRate(voice: Pick<Voice, "speakingRate">): number {
  return clampInworldSpeakingRate(voice.speakingRate) ?? INWORLD_SPEAKING_RATE_DEFAULT
}

/** Fields to POST with /api/v1/voice/tts. Omits defaults so existing voices stay Flash. */
export function inworldSynthFieldsFromVoice(
  voice: Pick<Voice, "speakingRate" | "deliveryMode" | "audioQuality">,
): InworldSynthFields {
  const fields: InworldSynthFields = {}
  const speakingRate = clampInworldSpeakingRate(voice.speakingRate)
  if (speakingRate !== undefined) fields.speakingRate = speakingRate
  if (isInworldDeliveryMode(voice.deliveryMode)) fields.deliveryMode = voice.deliveryMode
  if (isInworldAudioQuality(voice.audioQuality)) fields.audioQuality = voice.audioQuality
  return fields
}
