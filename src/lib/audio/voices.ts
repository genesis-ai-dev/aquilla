// The Voice library: built-in presets + helpers to read/resolve voices from
// project settings. The preset list is the project's default library when
// `ttsSettings.voices` is empty; once the user creates or forks a voice we
// store the full list explicitly.

import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

export const DEFAULT_PROMPT_TEMPLATE = [
  "Read this {target} text naturally.",
  "Accent or reading tradition: {accent}.",
  "If unsure of pronunciation, use {pronunciationReference} as the closest reference.",
  "Preserve exact wording, punctuation, names, and verse boundaries — do not translate, summarize, or normalize.",
  "",
  "{text}",
].join("\n")

/**
 * Built-in voices the user starts with. They cover a useful spread of
 * narrator / character / mood archetypes. Editable by forking.
 */
export const PRESET_VOICES: readonly Voice[] = [
  {
    id: "preset-narrator",
    name: "Narrator",
    color: "#6366f1",
    provider: "gemini",
    voiceName: "Charon",
    prompt: "Read this {target} passage as a steady, clear narrator. Preserve names and punctuation; do not translate.\n\n{text}",
    builtIn: true,
  },
  {
    id: "preset-elder",
    name: "Elder",
    color: "#a16207",
    provider: "gemini",
    voiceName: "Gacrux",
    prompt: "Read in a warm, mature elder's voice with steady pacing.\n\n{text}",
    builtIn: true,
  },
  {
    id: "preset-child",
    name: "Child",
    color: "#ec4899",
    provider: "gemini",
    voiceName: "Leda",
    prompt: "Read in a youthful, light voice.\n\n{text}",
    builtIn: true,
  },
  {
    id: "preset-excited",
    name: "Excited",
    color: "#f97316",
    provider: "gemini",
    voiceName: "Puck",
    prompt: "Read with energetic, upbeat delivery — like an enthusiastic announcement.\n\n{text}",
    builtIn: true,
  },
  {
    id: "preset-calm",
    name: "Calm",
    color: "#14b8a6",
    provider: "gemini",
    voiceName: "Aoede",
    prompt: "Read gently and breezily, with relaxed pacing.\n\n{text}",
    builtIn: true,
  },
  {
    id: "preset-whisper",
    name: "Whisper",
    color: "#475569",
    provider: "gemini",
    voiceName: "Enceladus",
    prompt: "Read in a hushed, breathy near-whisper.\n\n{text}",
    builtIn: true,
  },
] as const

export const DEFAULT_VOICE_ID = PRESET_VOICES[0].id

export const VOICE_PALETTE: readonly string[] = [
  "#6366f1", "#a16207", "#ec4899", "#f97316", "#14b8a6", "#475569",
  "#0ea5e9", "#8b5cf6", "#22c55e", "#ef4444", "#eab308", "#06b6d4",
]

/** The effective list of voices available to a project. */
export function getVoiceLibrary(settings: ProjectTtsSettings | undefined): Voice[] {
  const stored = settings?.voices
  if (!stored || stored.length === 0) return [...PRESET_VOICES]
  return stored
}

export function findVoice(settings: ProjectTtsSettings | undefined, voiceId: string | undefined): Voice | undefined {
  if (!voiceId) return undefined
  return getVoiceLibrary(settings).find((v) => v.id === voiceId)
}

/**
 * Resolve which voice to use for a cell.
 * Order: cell.voiceId -> project.defaultVoiceId -> first preset.
 */
export function resolveVoice(
  settings: ProjectTtsSettings | undefined,
  cellVoiceId: string | undefined,
): Voice {
  const library = getVoiceLibrary(settings)
  return (
    (cellVoiceId ? library.find((v) => v.id === cellVoiceId) : undefined) ??
    (settings?.defaultVoiceId ? library.find((v) => v.id === settings.defaultVoiceId) : undefined) ??
    library[0] ??
    PRESET_VOICES[0]
  )
}

export function newVoiceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Fork a built-in voice into a user-editable copy. */
export function forkVoice(voice: Voice, name?: string): Voice {
  return {
    ...voice,
    id: newVoiceId(),
    name: name ?? `${voice.name} (copy)`,
    builtIn: false,
  }
}
