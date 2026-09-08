// Inworld Voice Design (AQU-1189) — text description → preview voices → publish.
//
// https://docs.inworld.ai/tts/voice-design
// The browser never holds the Inworld key; sync-worker proxies design + publish.

export const INWORLD_VOICE_DESIGN_DOCS_URL = "https://docs.inworld.ai/tts/voice-design"

export const INWORLD_DESIGN_PROMPT_MIN = 30
export const INWORLD_DESIGN_PROMPT_MAX = 1000
export const INWORLD_DESIGN_SAMPLE_COUNT = 3
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
