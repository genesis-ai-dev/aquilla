// AQU-2037 — a voice belongs to the target lane it was made in.
//
// Before this, a project had ONE voice library and every target lane shared it:
// an Arabic lane and a Samoan lane listed the same 42 voices, a cell on the
// Samoan lane stayed cast to an Inworld Arabic voice, and Generate spoke the
// Samoan text with it. `Voice.laneId` records the lane; everything here is the
// pure rule for reading that field, so the question "which voices does this
// lane have?" has exactly one answer.
//
// TWO HALVES, ON PURPOSE:
//
//  - `laneScopedTtsSettings` is the READ view. Hand it to any surface that
//    lists or resolves voices and that surface becomes lane-correct without
//    knowing lanes exist — the Voices panel, the per-cell picker, the batch
//    dialog, the Media-timeline picker, the cast gutter and Generate all read
//    the library through `getVoiceLibrary`/`resolveVoice`/`findVoice`.
//  - `stampNewVoiceLanes` is the WRITE rule, applied once in `useProjectTts`'s
//    `saveTts`. Every mint site writes the FULL next library through there, so
//    stamping in that one place covers New voice / Clone / voice design, an
//    import with speaker labels, diarization and "Adopt voices as cast" — and
//    keeps each of those sites free of lane plumbing.
//
// NEVER WRITE THE READ VIEW BACK. It holds one lane's voices; storing it would
// delete every other lane's. Writers take the full `settings`/`allVoices`.
//
// An ABSENT `laneId` means "every lane" (see the field's doc comment): voices
// stored before AQU-2037 keep working everywhere until AQU-2039 migrates them,
// and a `builtIn` preset is never stamped because every lane falls back to it.

import { PRESET_VOICES, getVoiceLibrary, resolveVoice } from "@/lib/audio/voices"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

/**
 * Is this voice offered on `laneId`?
 *
 * A null/empty `laneId` is "no lane in view" — a project with no target lane
 * rows at all, or a surface that never resolved one. Nothing is scoped then,
 * which is exactly the pre-AQU-2037 behaviour.
 */
export function voiceInLane(voice: Pick<Voice, "laneId">, laneId: string | null | undefined): boolean {
  if (!laneId) return true
  return voice.laneId === undefined || voice.laneId === laneId
}

/** The subset of `voices` offered on `laneId`, in library order. */
export function voicesForLane(voices: readonly Voice[], laneId: string | null | undefined): Voice[] {
  if (!laneId) return [...voices]
  return voices.filter((voice) => voiceInLane(voice, laneId))
}

/**
 * The effective library for one lane.
 *
 * Falls back to the built-in presets when the lane has none of its own, so a
 * target lane added to a project whose voices all belong elsewhere lists the
 * Narrator rather than nothing — the same rule `getVoiceLibrary` applies to a
 * project that has never opened the studio.
 */
export function laneVoiceLibrary(
  settings: ProjectTtsSettings | undefined,
  laneId: string | null | undefined,
): Voice[] {
  const all = getVoiceLibrary(settings)
  if (!laneId) return all
  const mine = voicesForLane(all, laneId)
  return mine.length > 0 ? mine : [...PRESET_VOICES]
}

/**
 * The voice a lane speaks with when nothing in the lane is assigned.
 *
 * The built-in Narrator first: AQU-2037 leaves the starred default ONE PER
 * PROJECT (the per-lane default is AQU-2041), so a lane whose project default
 * belongs to another lane falls back to the Narrator rather than to whichever
 * voice happens to sit first in its list.
 */
function laneFallbackVoice(library: readonly Voice[]): Voice {
  return library.find((voice) => voice.builtIn) ?? library[0] ?? PRESET_VOICES[0]
}

/**
 * Resolve the voice a cell speaks with ON `laneId`.
 *
 * Order: the cell's own voice, then the project's starred default, then the
 * lane fallback — but each of the first two counts only while it is a voice
 * THIS lane has. A cell cast to another lane's voice therefore reads as
 * unassigned here, which is what makes Generate stop crossing lanes.
 */
export function resolveLaneVoice(
  settings: ProjectTtsSettings | undefined,
  cellVoiceId: string | undefined,
  laneId: string | null | undefined,
): Voice {
  if (!laneId) return resolveVoice(settings, cellVoiceId)
  const library = laneVoiceLibrary(settings, laneId)
  const inLane = (id: string | undefined) => (id ? library.find((voice) => voice.id === id) : undefined)
  return inLane(cellVoiceId) ?? inLane(settings?.defaultVoiceId) ?? laneFallbackVoice(library)
}

/**
 * The TTS settings as ONE LANE sees them: its own voices, its resolved
 * default, and only the cast assignments pointing at voices it has.
 *
 * Read-only — see the header. Returns the input unchanged when there is no
 * lane to scope to, so a project with no target lane rows is byte-identical to
 * before this ticket.
 */
export function laneScopedTtsSettings(
  settings: ProjectTtsSettings | undefined,
  laneId: string | null | undefined,
): ProjectTtsSettings | undefined {
  if (!settings || !laneId) return settings
  const voices = laneVoiceLibrary(settings, laneId)
  const ids = new Set(voices.map((voice) => voice.id))
  const scoped: ProjectTtsSettings = {
    ...settings,
    voices,
    defaultVoiceId: resolveLaneVoice(settings, undefined, laneId).id,
  }
  // Keep the key's presence as we found it: a project that never opened the
  // studio has no `castAssignments`, and a read view must not invent one.
  if (settings.castAssignments !== undefined) {
    const kept: Record<string, string> = {}
    for (const [cellId, voiceId] of Object.entries(settings.castAssignments)) {
      if (ids.has(voiceId)) kept[cellId] = voiceId
    }
    scoped.castAssignments = kept
  }
  return scoped
}

/**
 * Put a voice in `laneId` — unless it already names a lane, or is a `builtIn`
 * preset (which belongs to every lane), or there is no lane to put it in.
 */
export function stampVoiceLane(voice: Voice, laneId: string | null | undefined): Voice {
  if (!laneId || voice.builtIn || voice.laneId !== undefined) return voice
  return { ...voice, laneId }
}

/**
 * The library to store: `next`, with every voice that is NOT already in
 * `previous` stamped with the active lane.
 *
 * Keyed on "is this id already stored?" rather than on which dialog wrote it,
 * because that is the one question every mint site answers the same way. Two
 * consequences both wanted: editing a voice never moves it to the lane the
 * editor happens to be on, and a voice stored before AQU-2037 stays lane-less
 * (visible everywhere) even when it is edited, until AQU-2039 migrates it.
 *
 * `previous` is the STORED list (`settings.voices`), not `getVoiceLibrary`'s
 * preset substitute: on a project whose library has never been written, the
 * seeded Narrator rides along in `next` and is left alone by the `builtIn`
 * rule, while the voice the user just made is new and gets the lane.
 */
export function stampNewVoiceLanes(
  next: readonly Voice[],
  previous: readonly Voice[] | undefined,
  laneId: string | null | undefined,
): Voice[] {
  if (!laneId) return [...next]
  const stored = new Set((previous ?? []).map((voice) => voice.id))
  return next.map((voice) => (stored.has(voice.id) ? voice : stampVoiceLane(voice, laneId)))
}
