// AQU-2125 — casting by character: the pure rules.
//
// The lookup itself lives with the other cast lookups in `voices.ts`
// (`assignedCastVoiceId` reads a line's own entry, then `character:<name>`).
// This module is everything that WRITES or RESHAPES the map around that rule:
//
//  - `expandCharacterCast`: the read view with each loaded line's character
//    entry written out as the line's own, in memory only, so the many surfaces
//    that look a voice up by line id alone keep answering correctly.
//  - `foldCastByCharacter`: turn one-entry-per-line casting into one entry per
//    character, dropping every line entry that only repeats its character.
//  - `buildCharacterCastWrite`: what a character sheet stores now — a voice per
//    character, not per line.
//  - `setLaneCharacterCast`: "use this voice for every «name» line" on a lane.
//
// THE RULE THE FOLD KEEPS. Every line that had a voice keeps exactly that voice:
// a line entry is dropped only when the character's entry names the same voice,
// and a line cast differently keeps its own entry. A line that names a character
// but was never given a voice (say, because the save that would have cast it
// was refused at the size cap) picks up its character's voice — unless the fold
// is asked to keep it voiceless, which marks it with `NO_CAST_VOICE`. A line with
// a voice pinned on the cell itself is always marked: its pin is what it spoke.

import { laneTtsSettings, setLaneCast, LANE_CAST_DEFAULT } from "@/lib/audio/lane-cast"
import { laneScopedTtsSettings } from "@/lib/audio/voice-lanes"
import {
  NO_CAST_VOICE,
  VOICE_PALETTE,
  assignedCastVoiceId,
  castNameOf,
  characterCastKey,
  getVoiceLibrary,
  type CastSubject,
} from "@/lib/audio/voices"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

/** A line that names a character. */
export interface CastLine {
  id: string
  castName: string
  /** The line has a voice pinned on the cell itself (`cell.ttsSettings.voiceId`).
   *  A cast entry outranks a pin, so a fold must not hand such a line its
   *  character's voice where it had no entry — it marks it instead. */
  hasOwnVoice?: boolean
}

function ownEntry(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/** The lines among `cells` that name a character, in the order given. */
export function castLinesOf(
  cells: Iterable<Exclude<CastSubject, string> & { ttsSettings?: { voiceId?: string } | null }>,
): CastLine[] {
  const out: CastLine[] = []
  const seen = new Set<string>()
  for (const cell of cells) {
    const castName = castNameOf(cell)
    if (!castName || seen.has(cell.id)) continue
    seen.add(cell.id)
    out.push({ id: cell.id, castName, ...(cell.ttsSettings?.voiceId ? { hasOwnVoice: true } : {}) })
  }
  return out
}

/**
 * The settings with each listed line's character entry copied onto the line
 * itself, wherever the line has no entry of its own.
 *
 * A READ VIEW, like the lane projection it sits on top of: it exists so that a
 * surface which only knows a line's id (the recorder, a bulk Generate, the
 * playback bar) still finds the voice the line's character is cast with. Never
 * write it back — that would undo the whole point and store one entry per line
 * again. Returns the same object when there is nothing to copy, so a project
 * with no character entries is byte-identical to before.
 */
export function expandCharacterCast(
  settings: ProjectTtsSettings | undefined,
  lines: readonly CastLine[],
): ProjectTtsSettings | undefined {
  const map = settings?.castAssignments
  if (!settings || !map || lines.length === 0) return settings
  let next: Record<string, string> | null = null
  for (const line of lines) {
    if (ownEntry(next ?? map, line.id) !== undefined) continue
    const voiceId = ownEntry(map, characterCastKey(line.castName))
    if (voiceId === undefined) continue
    next ??= { ...map }
    next[line.id] = voiceId
  }
  return next ? { ...settings, castAssignments: next } : settings
}

export interface CastFold {
  /** The folded map. A new object; the input is not touched. */
  castAssignments: Record<string, string>
  /** Line entries dropped because the line's character now says the same. */
  droppedLineEntries: number
  /** Characters given an entry of their own. */
  characterEntries: number
  /** Lines naming a newly cast character that had no voice — they now speak with it. */
  newlyVoicedLines: number
  /** …or were marked to keep what they had: every such line with `keepUncastLines`,
   *  and always a line with its own pinned voice. */
  markedLines: number
  /** False when the fold changed nothing, so the caller can skip a write. */
  changed: boolean
}

/**
 * Fold one-entry-per-line casting into one entry per character.
 *
 * For each character among `lines`: if it has no entry yet, it gets the voice
 * most of its lines are cast with (ties go to the first line's voice). Then
 * every one of its lines whose entry equals the character's voice loses that
 * entry. Lines cast to a different voice keep theirs. See the header for what
 * happens to a line that names the character but had no voice.
 */
export function foldCastByCharacter(
  map: Readonly<Record<string, string>> | undefined,
  lines: readonly CastLine[],
  opts: { keepUncastLines?: boolean } = {},
): CastFold {
  const next: Record<string, string> = { ...(map ?? {}) }
  const byName = new Map<string, string[]>()
  const pinned = new Set<string>()
  const seen = new Set<string>()
  for (const line of lines) {
    const name = line.castName.trim()
    if (!name || seen.has(line.id)) continue
    seen.add(line.id)
    if (line.hasOwnVoice) pinned.add(line.id)
    const ids = byName.get(name)
    if (ids) ids.push(line.id)
    else byName.set(name, [line.id])
  }

  let droppedLineEntries = 0
  let characterEntries = 0
  let newlyVoicedLines = 0
  let markedLines = 0
  for (const [name, ids] of byName) {
    const key = characterCastKey(name)
    let voiceId = ownEntry(next, key)
    if (voiceId === undefined) {
      // Map iteration is insertion order, so on a tie the first line's voice wins.
      const counts = new Map<string, number>()
      for (const id of ids) {
        const own = ownEntry(next, id)
        if (own === undefined || own === NO_CAST_VOICE) continue
        counts.set(own, (counts.get(own) ?? 0) + 1)
      }
      let best: string | undefined
      let bestCount = 0
      for (const [candidate, count] of counts) {
        if (count > bestCount) {
          best = candidate
          bestCount = count
        }
      }
      if (best === undefined) continue
      voiceId = best
      const uncast = ids.filter((id) => ownEntry(next, id) === undefined)
      next[key] = voiceId
      characterEntries += 1
      for (const id of uncast) {
        if (opts.keepUncastLines || pinned.has(id)) {
          next[id] = NO_CAST_VOICE
          markedLines += 1
        } else {
          newlyVoicedLines += 1
        }
      }
    }
    for (const id of ids) {
      if (ownEntry(next, id) !== voiceId) continue
      delete next[id]
      droppedLineEntries += 1
    }
  }
  return {
    castAssignments: next,
    droppedLineEntries,
    characterEntries,
    newlyVoicedLines,
    markedLines,
    changed: droppedLineEntries + characterEntries + markedLines > 0,
  }
}

export interface CharacterCastWrite {
  /** Full voice library to persist (existing + newly created). */
  voices: Voice[]
  /** The whole project-wide cast map to persist. */
  castAssignments: Record<string, string>
}

/**
 * What a character sheet stores: one voice per character, and the CHARACTER's
 * entry rather than one per line — the sheet has just written each line's
 * `cast_name`, so the line already says who it is.
 *
 * Voices are matched by name and reused, exactly as `buildCastAdditions` does,
 * so clearing a sheet and importing it again gives every character back the
 * same voice and colour. A character that already has a working entry keeps it:
 * re-importing a sheet must not undo someone recasting Jesus with a trained
 * voice. The imported lines' own entries are dropped, because the sheet has
 * just told them who they are; before this change the import overwrote them
 * with the named voice, which is what they now resolve to through the
 * character.
 */
export function buildCharacterCastWrite(
  assignments: readonly { cellId: string; castName: string | null | undefined }[],
  settings: ProjectTtsSettings | undefined,
  mintId: () => string,
): CharacterCastWrite {
  const voices: Voice[] = [...getVoiceLibrary(settings)]
  const byName = new Map<string, string>()
  for (const v of voices) byName.set(v.name, v.id)
  const libraryIds = new Set(voices.map((v) => v.id))

  const castAssignments: Record<string, string> = { ...(settings?.castAssignments ?? {}) }
  for (const { cellId, castName } of assignments) {
    const name = castName?.trim()
    if (!name) continue
    delete castAssignments[cellId]
    let voiceId = byName.get(name)
    if (!voiceId) {
      voiceId = mintId()
      const color = VOICE_PALETTE[voices.length % VOICE_PALETTE.length]
      voices.push({ id: voiceId, name, color })
      byName.set(name, voiceId)
      libraryIds.add(voiceId)
    }
    const key = characterCastKey(name)
    const current = ownEntry(castAssignments, key)
    // A character sent back to "no voice" on purpose keeps that; one pointing
    // at a voice that has since been deleted is repaired with the named voice.
    if (current === undefined || (current !== NO_CAST_VOICE && !libraryIds.has(current))) {
      castAssignments[key] = voiceId
    }
  }
  return { voices, castAssignments }
}

/**
 * "Use this voice for every «name» line", on one lane.
 *
 * Writes the character's entry in the lane's own cast, and drops the lane's own
 * entries for `lineIds` (the character's lines the caller can see) so the
 * character's entry speaks for them. A line still held by a project-wide entry
 * on a different voice — one the fold has not reached yet — gets the choice as
 * a lane entry of its own, so every line the person can see says what they
 * picked. `voiceId: null` sends the character back to the lane's default.
 *
 * `laneId` is the lane ROW id, needed to read the result the way the lane sees
 * it (AQU-2037); `lane` is its legacy tag, the key the cast is stored under.
 */
export function setLaneCharacterCast(
  settings: ProjectTtsSettings | undefined,
  lane: string,
  laneId: string | null | undefined,
  castName: string,
  voiceId: string | null,
  lineIds: Iterable<string>,
): Pick<ProjectTtsSettings, "laneCastAssignments"> {
  const name = castName.trim()
  const ids = [...new Set(lineIds)]
  const written = setLaneCast(settings, lane, [characterCastKey(name)], voiceId)
  const laneMap = { ...(written.laneCastAssignments?.[lane] ?? {}) }
  for (const id of ids) delete laneMap[id]
  const draft: ProjectTtsSettings = {
    ...(settings ?? {}),
    laneCastAssignments: { ...(written.laneCastAssignments ?? {}), [lane]: laneMap },
  }
  const view = laneTtsSettings(laneScopedTtsSettings(draft, laneId), lane)
  const wanted = voiceId ?? undefined
  for (const id of ids) {
    if (assignedCastVoiceId(view, { id, castName: name }) !== wanted) {
      laneMap[id] = voiceId ?? LANE_CAST_DEFAULT
    }
  }
  return { laneCastAssignments: { ...(written.laneCastAssignments ?? {}), [lane]: laneMap } }
}

/**
 * How far a voice picked for one line reaches (Sam, Oct 23):
 *  - `line`: only this line — its own entry, the picker's default;
 *  - `file`: every line of this character in the open file, each with its own
 *    entry. Deliberate choices: the fold never drops them, because it folds the
 *    project-wide map and these are the lane's own entries, which a character
 *    entry never outranks. Other episodes' lines are left alone;
 *  - `everywhere`: the character itself, in every episode (`setLaneCharacterCast`).
 */
export type CastScope = "line" | "file" | "everywhere"

export interface CastPick {
  scope: CastScope
  /** The line the picker was opened on. */
  lineId: string
  /** Its character, if it has one. Without one only `line` applies. */
  castName: string | null | undefined
  /** This character's lines in the open file (the line itself included). */
  fileLineIds: Iterable<string>
  /** `null` sends the lines (or the character) back to the lane's default. */
  voiceId: string | null
}

/** The lane cast to save for one pick in the voice picker. */
export function castPickPatch(
  settings: ProjectTtsSettings | undefined,
  lane: string,
  laneId: string | null | undefined,
  pick: CastPick,
): Pick<ProjectTtsSettings, "laneCastAssignments"> {
  const name = pick.castName?.trim()
  const fileIds = [...new Set(pick.fileLineIds)]
  if (name && pick.scope === "everywhere") {
    return setLaneCharacterCast(settings, lane, laneId, name, pick.voiceId, fileIds.length > 0 ? fileIds : [pick.lineId])
  }
  if (name && pick.scope === "file") {
    return setLaneCast(settings, lane, fileIds.length > 0 ? fileIds : [pick.lineId], pick.voiceId)
  }
  return setLaneCast(settings, lane, [pick.lineId], pick.voiceId)
}
