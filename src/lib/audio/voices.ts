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
 * Built-in voices the user starts with. Three distinct moods — steady,
 * gentle, energetic — to cover most needs without overwhelming the
 * inventory. Editable in place.
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
    id: "preset-calm",
    name: "Calm",
    color: "#14b8a6",
    provider: "gemini",
    voiceName: "Aoede",
    prompt: "Read gently and breezily, with relaxed pacing.\n\n{text}",
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

/**
 * Resolve which cast member voices a specific cell, honoring a persisted
 * line→cast assignment first, then the cell's own voiceId, then the project
 * default. Used by the Voice Studio so every line speaks in its assigned
 * character's voice.
 */
export function resolveCastVoice(
  settings: ProjectTtsSettings | undefined,
  cellId: string,
  cellVoiceId?: string,
): Voice {
  const assigned = settings?.castAssignments?.[cellId]
  return resolveVoice(settings, assigned ?? cellVoiceId)
}

/** The cast member assigned to a cell, if any explicit assignment exists. */
export function assignedCastVoiceId(
  settings: ProjectTtsSettings | undefined,
  cellId: string,
): string | undefined {
  return settings?.castAssignments?.[cellId]
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
