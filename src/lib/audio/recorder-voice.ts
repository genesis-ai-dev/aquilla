// AQU-2510: WHICH VOICE the recorder's Generate speaks in — and where that
// answer came from, so the panel can say it before the credits are spent.
//
// The recording modal has always generated in the line's cast voice and said
// nothing about it: on a dubbing project whose whole point is a cloned voice,
// the performer could not target the voice they had just prepared. So the
// panel offers a pick, and a pick has to lose to a line that was deliberately
// cast — otherwise walking down a cast file would quietly re-voice every line
// with whatever was chosen on the first one.
//
// Hence four sources, in this order:
//
//   pick    — chosen on THIS line in this session. Always wins; the person
//             picking is looking at the line.
//   cast    — the line's own cast entry (or its character's), exactly as
//             `generateCellVoice` resolves it. Keeps parity with the
//             character-tag → sparkle path the editor already has.
//   carried — the last voice picked anywhere in this session, for a line
//             nobody cast. This is what stops "repeat generation re-asking".
//   default — the project default / narrator, as `resolveVoice` has it.
//
// `recorderVoiceOverride` is the other half of the deal: only `pick` and
// `carried` are passed to the generator as an override. A `cast` or `default`
// answer is left for `generateCellVoice` to resolve for itself, so a session
// that never opens the picker generates through the same code it always did.
//
// The resolver is pure. The session memory at the bottom is a module-level
// Map, deliberately NOT persisted: a pick is a working choice for this
// sitting, not a project setting.

import { assignedCastVoiceId, findVoice, resolveVoice } from "./voices"
import type { CastSubject } from "./voices"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

/** Where the recorder's generate voice came from. See the module note. */
export type RecorderVoiceSource = "pick" | "cast" | "carried" | "default"

export interface RecorderVoiceChoice {
  voice: Voice
  source: RecorderVoiceSource
}

/** The picks made in one sitting: per line, plus the last one made anywhere. */
export interface RecorderVoicePicks {
  /** The last voice picked anywhere in this session. */
  readonly carried?: string
  /** A pick made on one line, keyed by that line's id. */
  readonly byCell: Readonly<Record<string, string>>
}

export const NO_RECORDER_VOICE_PICKS: RecorderVoicePicks = { byCell: {} }

/** The id a pick is filed under: the line whose cast assignment applies. */
export function recorderVoiceKey(subject: CastSubject): string {
  return typeof subject === "string" ? subject : subject.id
}

export interface RecorderVoiceArgs {
  settings: ProjectTtsSettings | undefined
  /**
   * The line whose cast assignment applies — on a cue file, the linked
   * subtitle (a cue carries no assignment of its own), exactly as
   * `generateCellVoice`'s `voiceCellId` does it.
   */
  subject: CastSubject
  /** The line's own pinned voice (`cell.ttsSettings?.voiceId`). */
  cellVoiceId?: string | undefined
  picks?: RecorderVoicePicks | undefined
}

/**
 * The voice Generate would use for this line, and why.
 *
 * A pick naming a voice the project no longer has falls through rather than
 * resolving to the default under the label "pick" — the phantom-voice prune
 * (AQU-1941) can remove a voice between the pick and the press.
 */
export function recorderVoiceChoice(args: RecorderVoiceArgs): RecorderVoiceChoice {
  const { settings, subject, cellVoiceId } = args
  const picks = args.picks ?? NO_RECORDER_VOICE_PICKS
  const picked = findVoice(settings, picks.byCell[recorderVoiceKey(subject)])
  if (picked) return { voice: picked, source: "pick" }
  const cast = findVoice(settings, assignedCastVoiceId(settings, subject) ?? cellVoiceId)
  if (cast) return { voice: cast, source: "cast" }
  const carried = findVoice(settings, picks.carried)
  if (carried) return { voice: carried, source: "carried" }
  return { voice: resolveVoice(settings, undefined), source: "default" }
}

/**
 * The `voiceId` to hand the generator, or undefined to let it resolve the
 * line's voice itself — see the module note.
 */
export function recorderVoiceOverride(choice: RecorderVoiceChoice | null | undefined): string | undefined {
  if (!choice) return undefined
  return choice.source === "pick" || choice.source === "carried" ? choice.voice.id : undefined
}

/** Record a pick on one line; it also becomes the carried one. Pure. */
export function withRecorderVoicePick(picks: RecorderVoicePicks, subject: CastSubject, voiceId: string): RecorderVoicePicks {
  return { carried: voiceId, byCell: { ...picks.byCell, [recorderVoiceKey(subject)]: voiceId } }
}

// ── the session memory ────────────────────────────────────────────────────
// Per project, for this tab's lifetime. The modal holds the picks in React
// state while it is open and writes them through here, so reopening it on the
// next line still knows what was picked on the last one.

const picksByProject = new Map<string, RecorderVoicePicks>()

export function recorderVoicePicks(projectId: string): RecorderVoicePicks {
  return picksByProject.get(projectId) ?? NO_RECORDER_VOICE_PICKS
}

export function rememberRecorderVoicePicks(projectId: string, picks: RecorderVoicePicks): void {
  picksByProject.set(projectId, picks)
}

/** Tests only: forget one project's picks, or every project's. */
export function resetRecorderVoicePicksForTests(projectId?: string): void {
  if (projectId === undefined) picksByProject.clear()
  else picksByProject.delete(projectId)
}
