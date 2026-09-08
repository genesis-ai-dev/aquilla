// Inworld Voice Design (AQU-1189) — text description → preview voices → publish.
//
// https://docs.inworld.ai/tts/voice-design
// The browser never holds the Inworld key; sync-worker proxies design + publish.

export const INWORLD_VOICE_DESIGN_DOCS_URL = "https://docs.inworld.ai/tts/voice-design"

export const INWORLD_DESIGN_PROMPT_MIN = 30
export const INWORLD_DESIGN_PROMPT_MAX = 1000
export const INWORLD_DESIGN_SAMPLE_COUNT = 3
/** Portal Freeform — Inworld turns the description into a voice profile. */
export const INWORLD_DESIGN_PROMPT_MODE_ASSISTED = "DESIGN_PROMPT_MODE_ASSISTED"
/** Portal Structured — `designPrompt` is the profile, used verbatim. */
export const INWORLD_DESIGN_PROMPT_MODE_VERBATIM = "DESIGN_PROMPT_MODE_VERBATIM"

export type InworldDesignPromptMode =
  | typeof INWORLD_DESIGN_PROMPT_MODE_ASSISTED
  | typeof INWORLD_DESIGN_PROMPT_MODE_VERBATIM

export type InworldDesignMode = "freeform" | "structured"

/** Attribute order Inworld's Structured tab sends, one `key: value` line each. */
export const INWORLD_DESIGN_PROFILE_KEYS = [
  "dialect",
  "gender",
  "age",
  "emotion",
  "tone",
  "pitch",
  "volume",
  "speed",
  "clarity",
  "fluency",
  "personality",
  "texture",
  "environment",
] as const

export type InworldDesignProfileKey = (typeof INWORLD_DESIGN_PROFILE_KEYS)[number]
export type InworldVoiceProfile = Record<InworldDesignProfileKey, string>
export type InworldVoiceProfileExtra = { key: string; value: string }

const PROFILE_KEY_SET = new Set<string>(INWORLD_DESIGN_PROFILE_KEYS)
const PROFILE_LINE = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/

export function blankInworldVoiceProfile(): InworldVoiceProfile {
  return {
    dialect: "",
    gender: "",
    age: "",
    emotion: "",
    tone: "",
    pitch: "",
    volume: "",
    speed: "",
    clarity: "",
    fluency: "",
    personality: "",
    texture: "",
    environment: "",
  }
}

export function parseInworldVoiceProfile(text: string): {
  profile: InworldVoiceProfile
  extras: InworldVoiceProfileExtra[]
} {
  const profile = blankInworldVoiceProfile()
  const extras: InworldVoiceProfileExtra[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(PROFILE_LINE)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2]
    if (PROFILE_KEY_SET.has(key)) {
      profile[key as InworldDesignProfileKey] = value
    } else {
      extras.push({ key: match[1], value })
    }
  }
  return { profile, extras }
}

export function serializeInworldVoiceProfile(
  profile: InworldVoiceProfile,
  extras: readonly InworldVoiceProfileExtra[] = [],
): string {
  const lines = INWORLD_DESIGN_PROFILE_KEYS.map((key) => `${key}: ${profile[key] ?? ""}`)
  for (const extra of extras) {
    const name = extra.key.trim()
    if (!name) continue
    lines.push(`${name}: ${extra.value}`)
  }
  return lines.join("\n")
}

export function inworldVoiceProfileHasValue(
  profile: InworldVoiceProfile,
  extras: readonly InworldVoiceProfileExtra[] = [],
): boolean {
  return INWORLD_DESIGN_PROFILE_KEYS.some((key) => profile[key].trim().length > 0)
    || extras.some((row) => row.value.trim().length > 0)
}

/** True when most lines are `key: value` and at least one is a known profile key. */
export function looksLikeInworldVoiceProfile(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length === 0) return false
  let keyed = 0
  let known = 0
  for (const line of lines) {
    const match = line.match(PROFILE_LINE)
    if (!match) continue
    keyed += 1
    if (PROFILE_KEY_SET.has(match[1].toLowerCase())) known += 1
  }
  return known >= 1 && keyed >= Math.ceil(lines.length / 2)
}

export function initialInworldDesignMode(prompt: string): InworldDesignMode {
  return looksLikeInworldVoiceProfile(prompt) ? "structured" : "freeform"
}
/** Inworld asks for ~50–400 English characters so the preview is 1–30 seconds. */
export const INWORLD_DESIGN_PREVIEW_TEXT_MIN = 50
export const INWORLD_DESIGN_PREVIEW_TEXT_MAX = 400
/** BSB Revelation 1:17–18 — default spoken script for Voice Design previews. */
export const INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT =
  "Do not be afraid. I am the First and the Last, the Living One. I was dead, and behold, now I am alive forever and ever! And I hold the keys of Death and of Hades."

/** Published / draft Voice Design ids look like `{workspace}__design-voice-{hex}`. */
export function isInworldDesignedVoiceId(value: string | undefined): boolean {
  return Boolean(value?.includes("design-voice"))
}

export function previewAudioMime(b64: string): string {
  if (b64.startsWith("SUQz") || b64.startsWith("//u")) return "audio/mpeg"
  if (b64.startsWith("UklGR")) return "audio/wav"
  return "audio/wav"
}

export function previewAudioSrc(b64: string): string {
  return `data:${previewAudioMime(b64)};base64,${b64}`
}
