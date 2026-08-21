import type { CharacterResolution, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { VOICE_PALETTE, getVoiceLibrary } from "@/lib/audio/voices"

export interface SpeakerAssignment {
  cellId: string
  speaker: string | undefined
}

export interface CastAdditions {
  /** Full voice library to persist (existing + newly created). */
  voices: Voice[]
  /** cellId → voiceId for every cue that had a speaker. */
  castAssignments: Record<string, string>
}

/** Labels that are structurally identifiers, never a person's name: bare
 *  numbers and timecodes ("12", "00:01:23,456"), positional labels
 *  ("clip 3", "segment_12"), and media/subtitle filenames. */
const NON_SPEAKER_LABEL: readonly RegExp[] = [
  /^\d+([.,:]\d+)*$/,
  /^(clip|cue|segment|section|cell|line|track|part|chunk|take|item|row)[\s_-]*\d+$/i,
  /\.(wav|mp3|m4a|aac|ogg|opus|flac|webm|mp4|mov|mkv|vtt|srt|txt|json)$/i,
]

/** A label set this large is a big enough sample to judge whether it repeats. */
const MIN_LABELS_TO_JUDGE_REPETITION = 4

function isSpeakerName(label: string): boolean {
  return !NON_SPEAKER_LABEL.some((re) => re.test(label))
}

/**
 * AQU-813: keep only (cellId, speaker) pairs that plausibly describe a **cast**,
 * dropping per-clip identifiers that would otherwise become phantom voices.
 *
 * Legacy Codex reuses one `cellLabel` field both for a character name and for a
 * per-cell identifier, so importing a project whose audio carries no voice
 * labels used to mint one Voice per clip — a single speaker showing up as dozens
 * of "voices". Two guards, applied to the whole import's labels at once:
 *
 *   1. drop labels that can't be a name (see `NON_SPEAKER_LABEL`);
 *   2. drop the *entire* set when its names barely repeat — a cast is a small
 *      set of names recurring across many lines, so more distinct labels than
 *      half the labelled cells means it's an identifier column, not a cast.
 *
 * Small sets (< `MIN_LABELS_TO_JUDGE_REPETITION`) skip guard 2 — too little
 * signal to call it either way, and a genuine two-hander would fail it.
 * Label-less audio then imports as one default voice rather than N fabricated
 * ones. Explicit voice metadata (VTT `<v Name>`, a spreadsheet cast column,
 * diarization's own "Speaker N") never routes through here.
 */
export function castLikeSpeakers(pairs: readonly SpeakerAssignment[]): SpeakerAssignment[] {
  const named: SpeakerAssignment[] = []
  for (const p of pairs) {
    const name = p.speaker?.trim()
    if (!name || !isSpeakerName(name)) continue
    named.push({ cellId: p.cellId, speaker: name })
  }
  const distinct = new Set(named.map((p) => p.speaker)).size
  if (named.length >= MIN_LABELS_TO_JUDGE_REPETITION && distinct * 2 > named.length) return []
  return named
}

/**
 * Given parsed (cellId, speaker) pairs and the current settings, mint one Voice
 * per *new* distinct speaker name (case-sensitive, trimmed) and build the
 * cellId→voiceId assignment map. Names already in the cast are reused. `mintId`
 * is injected for testability (production passes uuidv7).
 *
 * Seeds the voice list from `getVoiceLibrary(settings)` so that a project that
 * has never opened Voice Studio still starts with the built-in Narrator preset
 * as library[0] / default. Custom libraries are reused as-is.
 */
export function buildCastAdditions(
  pairs: SpeakerAssignment[],
  settings: ProjectTtsSettings | undefined,
  mintId: () => string,
): CastAdditions {
  const voices: Voice[] = [...getVoiceLibrary(settings)]
  const byName = new Map<string, string>() // name → voiceId
  for (const v of voices) byName.set(v.name, v.id)

  const castAssignments: Record<string, string> = {}
  for (const { cellId, speaker } of pairs) {
    const name = speaker?.trim()
    if (!name) continue
    let voiceId = byName.get(name)
    if (!voiceId) {
      voiceId = mintId()
      const color = VOICE_PALETTE[voices.length % VOICE_PALETTE.length]
      voices.push({ id: voiceId, name, color })
      byName.set(name, voiceId)
    }
    castAssignments[cellId] = voiceId
  }
  return { voices, castAssignments }
}

/**
 * Does this cell carry anything a character sheet put there?
 *
 * THE PREDICATE A CLEAR IS DEFINED BY, and the reason it is shared rather than
 * written twice: the confirmation has to promise exactly what the clear will
 * do. It quoted the NAMED count while the clear collected this wider set, so on
 * a file where somebody had resolved a camera angle onto an unnamed line the
 * dialog would have promised fewer lines than it touched — understating a
 * warning whose whole job is to be believed.
 *
 * Wider than "has a name" on purpose. The character-check drawer's resolve path
 * writes a camera angle on its own, so a line can carry an angle with no name,
 * and a clear that stepped over those would leave stray angles behind for a
 * corrected sheet to export against lines nobody speaks.
 */
export function carriesCharacterSheetData(cell: {
  metadata?: Record<string, unknown> | null
  cameraState?: unknown
}): boolean {
  const meta = cell.metadata
  if (meta && typeof meta.cast_name === "string" && meta.cast_name !== "") return true
  if (meta && typeof meta.line_number === "string" && meta.line_number !== "") return true
  return cell.cameraState !== undefined
}

export interface CastRemovals {
  /** cellId → voiceId, minus every cleared cell. */
  castAssignments: Record<string, string>
  /** The drawer's decisions, minus every one that named a cleared cell. */
  characterResolutions: Record<string, CharacterResolution>
}

/**
 * The mirror image of `buildCastAdditions`: what the project settings look like
 * once a character sheet has been cleared off a file. (AQU-646, 2026-08-20)
 *
 * THE VOICE LIBRARY IS DELIBERATELY UNTOUCHED. Sam, choosing between the two
 * readings of "clear": the roster of people survives, and only their lines lose
 * their names. That is not just leniency — `buildCastAdditions` matches by name
 * and reuses the entry it finds, so keeping the roster is what makes clearing a
 * sheet and re-importing it give every character back the SAME COLOUR. Pruning
 * the library would repaint the whole cast on every correction round, and would
 * also throw away voice settings someone had configured against a character.
 * The cost is cosmetic and momentary: right after a clear the cast list shows
 * people who currently have no lines.
 *
 * The assignments, by contrast, MUST go. `characterIdentity` resolves a cell's
 * character from `castAssignments` independently of `metadata.cast_name`, so
 * clearing only the cells would leave both audio exports still grouping lines
 * under a character whose name is gone from the file — a name that then appears
 * in a deliverable and nowhere in the app.
 *
 * Pure; no I/O.
 */
export function buildCastRemovals(
  cellIds: Iterable<string>,
  settings: ProjectTtsSettings | undefined,
): CastRemovals {
  const cleared = new Set(cellIds)

  const castAssignments: Record<string, string> = {}
  for (const [cellId, voiceId] of Object.entries(settings?.castAssignments ?? {})) {
    // Keyed by cell, project-wide: another file's cast must survive this.
    if (!cleared.has(cellId)) castAssignments[cellId] = voiceId
  }

  const characterResolutions: Record<string, CharacterResolution> = {}
  for (const [key, record] of Object.entries(settings?.characterResolutions ?? {})) {
    // `"<textCellId> <cueCellId>"` — a decision about which of two sheets to
    // believe means nothing once either side has been emptied, and leaving it
    // would re-apply a rejected value to a re-import.
    const [textCellId, cueCellId] = key.split(" ")
    if (cleared.has(textCellId) || cleared.has(cueCellId)) continue
    characterResolutions[key] = record
  }

  return { castAssignments, characterResolutions }
}
