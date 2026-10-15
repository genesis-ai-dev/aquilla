// AQU-1941 — the pure half of the phantom-voice prune.
//
// The Codex migration's cast step read every Codex cell label as a speaker
// name. For a Bible cell that label is the verse, so a migration run before the
// AQU-813 guard (2026-08-07) minted one Voice per verse: `iloko_ilo_the_chosen`
// carries 31,287 voices, of which 117 are the real cast (Narrator plus the
// Chosen characters) and 31,170 are verse references. The whole settings blob —
// 5.45 MB of it — is fetched by every member on every workspace open and every
// window focus, so the bloat is not cosmetic.
//
// `scripts/neon-prune-phantom-voices.ts` is the runner; everything here is pure
// so the keep rules can be tested on fixtures instead of against a database.
//
// NOT pruned: a cell's own `cell.voiceId`. A cell still pointing at a dropped
// voice resolves to the project default (`resolveVoice`), which is the right
// answer for a voice that was never a speaker — rewriting cells would mean
// events, and this is a settings repair.

import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { parseScriptureReference } from "@/lib/scripture-reference"

/**
 * The only keys `buildCastAdditions` writes when it mints a cast member from a
 * label: identity plus a palette colour. A voice carrying anything else has
 * been configured by a person (an engine, a stock voice, a clone reference, a
 * prompt, an accent …), which is the evidence that it is a real character —
 * whatever its name looks like. Keyed on the absence of configuration rather
 * than a list of "evidence" fields on purpose: a new Voice field then counts as
 * evidence by default, so the prune can only ever get more conservative.
 */
const UNCONFIGURED_VOICE_KEYS: readonly string[] = ["id", "name", "color"]

/**
 * Is this voice name a scripture reference rather than a speaker?
 *
 * `parseScriptureReference` is the app's strict reader — `[1-3]?` + a 2–3 letter
 * book code + `chapter[:verse]` — and it additionally refuses a book code the
 * canon doesn't have, so `ABC 1:1` is not a reference and a character actually
 * called that survives. The verse is REQUIRED here even though the parser
 * allows a chapter-only ref: `GEN 1` is a shape a person might reasonably name
 * something, and the migration minted cell labels, which carry the verse.
 */
export function isVerseNamedVoice(name: string | undefined): boolean {
  const ref = parseScriptureReference(name?.trim())
  return ref !== null && ref.verse !== null
}

/**
 * A voice the migration fabricated: named after a verse, never configured,
 * not a built-in preset, and not the project's default speaker. A verse-named
 * voice that IS the default is kept — the project speaks through it, and a
 * prune that silently removed the default would change what every unassigned
 * line sounds like.
 */
export function isPhantomVoice(voice: Voice, defaultVoiceId: string | undefined): boolean {
  if (!isVerseNamedVoice(voice.name)) return false
  if (voice.builtIn) return false
  if (voice.id === defaultVoiceId) return false
  return Object.entries(voice).every(
    ([key, value]) => value === undefined || UNCONFIGURED_VOICE_KEYS.includes(key),
  )
}

export interface PhantomVoicePrune {
  /** Nothing to drop — the caller must not write. */
  clean: boolean
  /** The TTS settings to store. Identical to the input when `clean`. */
  next: ProjectTtsSettings
  totalVoices: number
  keptVoices: number
  droppedVoices: number
  totalAssignments: number
  droppedAssignments: number
  /** First few dropped names, for the report line. */
  sampleDroppedNames: string[]
}

const SAMPLE_SIZE = 5

/**
 * Drop the verse-named phantoms and every cast assignment pointing at one.
 *
 * An absent or empty `voices` is left exactly as it is: empty means "use the
 * built-in presets" (`getVoiceLibrary`), and materialising that default into
 * storage would be a change this repair has no business making.
 *
 * An assignment pointing at a voice id that is in neither list is left alone —
 * it is already dangling, and this prune is not the place to decide what a
 * dangling assignment means.
 */
export function prunePhantomVoices(settings: ProjectTtsSettings | undefined): PhantomVoicePrune {
  const voices = settings?.voices ?? []
  const assignments = settings?.castAssignments ?? {}
  const totalAssignments = Object.keys(assignments).length
  const empty: PhantomVoicePrune = {
    clean: true,
    next: settings ?? {},
    totalVoices: voices.length,
    keptVoices: voices.length,
    droppedVoices: 0,
    totalAssignments,
    droppedAssignments: 0,
    sampleDroppedNames: [],
  }
  if (voices.length === 0) return empty

  const dropped = new Set<string>()
  const kept: Voice[] = []
  const sampleDroppedNames: string[] = []
  for (const voice of voices) {
    if (isPhantomVoice(voice, settings?.defaultVoiceId)) {
      dropped.add(voice.id)
      if (sampleDroppedNames.length < SAMPLE_SIZE) sampleDroppedNames.push(voice.name)
      continue
    }
    kept.push(voice)
  }
  if (dropped.size === 0) return empty

  const nextAssignments: Record<string, string> = {}
  for (const [cellId, voiceId] of Object.entries(assignments)) {
    if (!dropped.has(voiceId)) nextAssignments[cellId] = voiceId
  }
  const droppedAssignments = totalAssignments - Object.keys(nextAssignments).length

  const next: ProjectTtsSettings = { ...settings, voices: kept }
  // Keep the key's presence as we found it: a project that never opened the
  // Studio has no `castAssignments`, and this prune must not give it one.
  if (settings?.castAssignments !== undefined) next.castAssignments = nextAssignments

  return {
    clean: false,
    next,
    totalVoices: voices.length,
    keptVoices: kept.length,
    droppedVoices: dropped.size,
    totalAssignments,
    droppedAssignments,
    sampleDroppedNames,
  }
}
