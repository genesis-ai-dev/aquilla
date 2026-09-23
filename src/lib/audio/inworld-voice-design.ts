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

/** Empty Structured textarea: one `key: ` line per attribute, ready to type into. */
export function blankStructuredDesignPrompt(): string {
  return INWORLD_DESIGN_PROFILE_KEYS.map((key) => `${key}: `).join("\n")
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
  const line = (key: string, value: string) => {
    const trimmed = value.trim()
    return trimmed.length > 0 ? `${key}: ${trimmed}` : `${key}:`
  }
  const lines = INWORLD_DESIGN_PROFILE_KEYS.map((key) => line(key, profile[key] ?? ""))
  for (const extra of extras) {
    const name = extra.key.trim()
    if (!name) continue
    lines.push(line(name, extra.value))
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

export function structuredDesignPromptHasValue(text: string): boolean {
  const parsed = parseInworldVoiceProfile(text)
  return inworldVoiceProfileHasValue(parsed.profile, parsed.extras)
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

/** Starting-point chips under the Voice Design prompt. English is the Inworld payload. */
export const INWORLD_DESIGN_PRESET_IDS = [
  "agent",
  "narrator",
  "companion",
  "instructor",
  "pirate",
] as const

export type InworldDesignPresetId = (typeof INWORLD_DESIGN_PRESET_IDS)[number]

type InworldDesignPreset = {
  freeform: string
  structured: InworldVoiceProfile
}

export const INWORLD_DESIGN_PRESETS: Record<InworldDesignPresetId, InworldDesignPreset> = {
  agent: {
    freeform:
      "A patient, helpful female voice, 25-40 years old. Warm, friendly tone with genuine empathy. Professional yet approachable. Skilled at conveying understanding and solutions.",
    structured: {
      dialect: "general american english",
      gender: "female",
      age: "adult",
      emotion: "empathetic and understanding",
      tone: "warm, friendly, and professional",
      pitch: "mid-range with gentle, reassuring inflections",
      volume: "moderate and consistent",
      speed: "moderate pace with thoughtful pauses",
      clarity: "clear and well-articulated",
      fluency: "fluent with no hesitations",
      personality: "patient, helpful, and approachable",
      texture: "smooth and warm",
      environment: "quiet indoor studio",
    },
  },
  narrator: {
    freeform:
      "A mature male voice speaking at a steady pace and neutral tone. The timbre is warm and resonant, conveying a sense of calm and authority, suitable for narrations.",
    structured: {
      dialect: "general american english",
      gender: "male",
      age: "middle-aged",
      emotion: "calm and composed",
      tone: "neutral, conveying a sense of authority",
      pitch: "low male pitch with a relatively flat contour",
      volume: "moderate and consistent",
      speed: "slow and deliberate, with measured pauses",
      clarity: "highly articulate and precise",
      fluency: "fluent and measured",
      personality: "authoritative and composed",
      texture: "warm and resonant",
      environment: "clean studio recording with very low noise",
    },
  },
  companion: {
    freeform:
      "A bright, enthusiastic young female voice in her early 20s. High energy with upward inflections and animated delivery. Fast-paced, bubbly tone with expressive variations.",
    structured: {
      dialect: "general american english",
      gender: "female",
      age: "young",
      emotion: "cheerful and enthusiastic",
      tone: "upbeat and animated",
      pitch: "medium-high female pitch with rising inflections",
      volume: "moderate to loud",
      speed: "fast-paced and energetic",
      clarity: "clear with expressive emphasis",
      fluency: "fluent and lively",
      personality: "bubbly, outgoing, and expressive",
      texture: "bright and youthful",
      environment: "quiet indoor studio",
    },
  },
  instructor: {
    freeform:
      "A soothing, calming female voice, 30-45 years old. Gentle, flowing delivery with natural pauses and smooth transitions. Warm, peaceful tone that creates relaxation without sounding robotic.",
    structured: {
      dialect: "general american english",
      gender: "female",
      age: "adult",
      emotion: "serene and reassuring",
      tone: "gentle and soothing",
      pitch: "low to mid-range with soft inflections",
      volume: "soft and even",
      speed: "slow, with long calming pauses",
      clarity: "clear and unhurried",
      fluency: "fluent with natural, flowing phrasing",
      personality: "calm, nurturing, and mindful",
      texture: "soft, breathy, and smooth",
      environment: "quiet indoor studio",
    },
  },
  pirate: {
    freeform:
      "A swaggering pirate captain in his fifties, loud and boisterous, with a harsh, gravelly rasp. He drags out his vowels and laughs mid-sentence.",
    structured: {
      dialect: "west country english",
      gender: "male",
      age: "adult",
      emotion: "amused and lighthearted",
      tone: "performative and theatrical",
      pitch: "medium-low male pitch with varied intonation for emphasis",
      volume: "loud and projecting",
      speed: "slow and deliberate, with dramatic pauses",
      clarity: "moderate, some words are slurred or mumbled",
      fluency: "fluent but interrupted by laughter",
      personality: "playful, confident, and a bit mischievous",
      texture: "harsh and raspy, with a gravelly, weathered quality",
      environment: "large, reverberant indoor space, like a hall or chamber",
    },
  },
}

export function inworldDesignPresetPrompt(
  id: InworldDesignPresetId,
  mode: InworldDesignMode,
): string {
  const preset = INWORLD_DESIGN_PRESETS[id]
  return mode === "structured"
    ? serializeInworldVoiceProfile(preset.structured)
    : preset.freeform
}

function foldDesignPrompt(text: string): string {
  return text.replace(/\r\n/g, "\n").trim()
}

/** Which chip matches the current textarea, or null after the user edits away. */
export function matchingInworldDesignPreset(
  text: string,
  mode: InworldDesignMode,
): InworldDesignPresetId | null {
  const folded = foldDesignPrompt(text)
  if (!folded) return null
  return INWORLD_DESIGN_PRESET_IDS.find(
    (id) => foldDesignPrompt(inworldDesignPresetPrompt(id, mode)) === folded,
  ) ?? null
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

export function inworldDesignPreviewExt(b64: string): "wav" | "mp3" {
  return previewAudioMime(b64) === "audio/mpeg" ? "mp3" : "wav"
}

export function inworldDesignPreviewBlob(b64: string): Blob {
  const binary = globalThis.atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: previewAudioMime(b64) })
}

/** Project-scoped R2 object name for a picked Voice Design sample. */
export function buildDesignPreviewAudioId(ext: string): string {
  const ts = Date.now()
  const rnd = Math.random().toString(36).slice(2, 11)
  return `design-preview-${ts}-${rnd}.${ext}`
}
