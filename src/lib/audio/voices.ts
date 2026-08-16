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
 * Built-in voices the user starts with. Just the Narrator — the project's
 * default speaker. Everything else is a character the user crafts (a preset
 * engine voice, or a cloned reference), so the cast starts clean instead of
 * pre-stuffed with stock moods. Editable in place.
 *
 * Round 5 (AQU-646): deliberately NO `provider` — the Narrator follows the
 * project's engine setting (a pinned "gemini" here silently overrode the
 * OmniVoice default and demanded a Gemini key on every fresh project). The
 * voiceName only applies when the resolved engine is Gemini; other engines
 * normalize it away (normalizeVoiceForProvider).
 */
export const PRESET_VOICES: readonly Voice[] = [
  {
    id: "preset-narrator",
    name: "Narrator",
    color: "#475569",
    voiceName: "Charon",
    prompt: "Read this {target} passage as a steady, clear narrator. Preserve names and punctuation; do not translate.\n\n{text}",
    builtIn: true,
  },
] as const

// Voice accent colors. Leads with calm slate / steel-blue / teal / amber tones —
// deliberately NOT purple-forward (the cliché AI-voice violet is pushed to the
// very end and only surfaces once a project has many voices).
export const VOICE_PALETTE: readonly string[] = [
  "#475569", "#0e7490", "#0d9488", "#2563eb", "#b45309", "#be123c",
  "#15803d", "#0ea5e9", "#ea580c", "#a16207", "#db2777", "#7c3aed",
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
