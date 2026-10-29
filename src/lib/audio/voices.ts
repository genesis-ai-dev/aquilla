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
 * engine voice, a character voice or a trained voice), so the cast starts clean instead of
 * pre-stuffed with stock moods. Editable in place.
 *
 * Round 5 (AQU-646): deliberately NO `provider` — the Narrator follows the
 * Inworld default and demanded a Gemini key on every fresh project). The
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

/** Append or replace a voice in a library. Pins a default if none is set. */
export function upsertVoice(
  voices: Voice[],
  voice: Voice,
  defaultVoiceId: string | undefined,
): { voices: Voice[]; defaultVoiceId: string | undefined } {
  const exists = voices.some((v) => v.id === voice.id)
  const next = exists ? voices.map((v) => (v.id === voice.id ? voice : v)) : [...voices, voice]
  return { voices: next, defaultVoiceId: defaultVoiceId ?? next[0]?.id }
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

// ── AQU-2125: casting a whole character ───────────────────────────────────
//
// The cast map used to hold one entry per LINE, and a dubbing project casts
// every line: a Come and See dubbing project reached 1.07 MB of project
// settings — over the 1 MB cap (AQU-1943) — and every casting save after that
// was refused. In a project cast from character sheets nearly every one of
// those entries repeats what the line already says: a line carrying the
// character "JESUS" (`metadata.cast_name`) speaks with Jesus's voice.
//
// So a character is cast ONCE, in the same map, under `character:<name>`. A
// line's own entry still wins: that is a deliberate choice for that one line.
// Keeping it in the same map (rather than a new settings key) means every rule
// already written for that map — the lane projection (AQU-2038), the lane
// scoping (AQU-2037), the read wall (AQU-2043), the phantom-voice prune
// (AQU-1941) and the size cap — applies to a character's entry unchanged, and
// a client that predates this reads it as a line nobody has.

/** The key prefix that marks a whole character's entry in a cast map. */
export const CHARACTER_CAST_PREFIX = "character:"

/** The cast-map key for one character. Names are matched trimmed, exactly as
 *  the character sheet and `buildCastAdditions` match them. */
export function characterCastKey(name: string): string {
  return CHARACTER_CAST_PREFIX + name.trim()
}

export function isCharacterCastKey(key: string): boolean {
  return key.startsWith(CHARACTER_CAST_PREFIX)
}

/**
 * A cast-map value meaning "no voice from the cast": the line (or character)
 * speaks with its own pinned voice or the default. Stored by a lane sent back
 * to its default (AQU-2038's `LANE_CAST_DEFAULT` is this same empty string),
 * and it has to outrank a character's entry, or casting a character would
 * recast a line someone deliberately sent back to the default.
 */
export const NO_CAST_VOICE = ""

/**
 * Who a cast lookup is about. A bare id finds only an entry made for that one
 * line. Anything carrying the line's `metadata` (a `CellData`, a cell view), or
 * a `castName` already read off it, also finds its character's entry — so pass
 * the line wherever you have it.
 */
export type CastSubject =
  | string
  | { id: string; metadata?: Record<string, unknown> | null; castName?: string | null }

/** The character a cast subject names, trimmed, or null. */
export function castNameOf(subject: CastSubject): string | null {
  if (typeof subject === "string") return null
  const raw = subject.castName !== undefined ? subject.castName : subject.metadata?.cast_name
  if (typeof raw !== "string") return null
  const name = raw.trim()
  return name === "" ? null : name
}

function ownEntry(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * Resolve which cast member voices a specific cell: the line's own entry, then
 * its character's entry, then the cell's own pinned voice, then the project
 * default. Used by the Voice Studio so every line speaks in its assigned
 * character's voice.
 */
export function resolveCastVoice(
  settings: ProjectTtsSettings | undefined,
  subject: CastSubject,
  cellVoiceId?: string,
): Voice {
  return resolveVoice(settings, assignedCastVoiceId(settings, subject) ?? cellVoiceId)
}

/**
 * The cast member assigned to a cell, if any: the line's own entry, else its
 * character's. `undefined` when neither names a voice — including an entry of
 * {@link NO_CAST_VOICE}, which stops the lookup there on purpose.
 */
export function assignedCastVoiceId(
  settings: ProjectTtsSettings | undefined,
  subject: CastSubject,
): string | undefined {
  const map = settings?.castAssignments
  if (!map) return undefined
  const own = ownEntry(map, typeof subject === "string" ? subject : subject.id)
  if (own !== undefined) return own === NO_CAST_VOICE ? undefined : own
  const name = castNameOf(subject)
  if (!name) return undefined
  const byCharacter = ownEntry(map, characterCastKey(name))
  return byCharacter === undefined || byCharacter === NO_CAST_VOICE ? undefined : byCharacter
}

export function newVoiceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
