// AQU-1758 / AQU-2212: what a line's voice does to the take you hear.
//
// The Audio view's voice card (CellVoicePanel, as #1685 left it) held these
// rules. When the card went with the Audio view, its jobs moved: the voice
// picker in Media's table, the line's Recording tab, and its take's menu and
// clip on the timeline. They all read the line through this one module, so
// a pick, the one-click button and the menu item can never disagree.
//
//   - A pick ACTS on the line. A voice that can re-voice the take (a clone or
//     a character) converts it at once; with no take, the voice reads the
//     text; a stock voice regenerates a generated take, but never reads over a
//     person's recording on its own.
//   - When the line's cast voice and its take part ways (a pick for the whole
//     file, or a stock voice over someone's recording), "Change to …" /
//     "Generate · …" offers the one click that brings them back together.
//   - A line nobody cast whose take is a person's recording names that
//     recording ("Your recording"), not the default voice.
//
// Pure: no React, no I/O.

import {
  CHANGE_VOICE_QUALITY_STEPS,
  changeVoiceBlocker,
  changeVoiceQualityForSteps,
  changeVoiceSourceTake,
  isVoiceChangedAudioId,
  voiceChangedSteps,
  type ChangeVoiceQuality,
} from "./change-voice"
import { keptWindowSec } from "./kept-window"
import { assignedCastVoiceId, findVoice, resolveCastVoice } from "./voices"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

/** What a line's voice would do to its take: re-voice it, or read the text. */
export type LineVoiceAction = "change" | "generate"

/** The take a line plays, as the card read it. */
export interface LineTake {
  /** A real recording wins over a generated voice. Absent: no take. */
  audioId?: string
  att?: NonNullable<CellData["attachments"]>[string]
  /** The line's section of an imported recording (the programme audio). */
  isSourceClip: boolean
  /** The line's generated voice. */
  isGenerated: boolean
  /** A person's take: a recording or the programme audio, not a voice. */
  human: boolean
  /** Who recorded it, for a person's own recording. */
  recordedBy?: string
}

export function lineTake(cell: CellData): LineTake {
  let audioId: string | undefined
  for (const id of [cell.selectedAudioId, cell.selectedGeneratedVoiceAudioId]) {
    if (!id) continue
    const att = cell.attachments?.[id]
    if (!att || att.isDeleted) continue
    audioId = id
    break
  }
  const att = audioId ? cell.attachments?.[audioId] : undefined
  const isSourceClip = keptWindowSec(cell, audioId, att).kind === "section"
  const isGenerated = Boolean(audioId && audioId === cell.selectedGeneratedVoiceAudioId && !isSourceClip)
  const human = Boolean(audioId && att && !isGenerated && !att.voiceId && !isVoiceChangedAudioId(audioId))
  return {
    ...(audioId ? { audioId } : {}),
    ...(att ? { att } : {}),
    isSourceClip,
    isGenerated,
    human,
    ...(human && !isSourceClip && att?.recordedBy ? { recordedBy: att.recordedBy } : {}),
  }
}

/**
 * The quality a re-voice runs at: the one stamped into the take's id when it
 * is itself a conversion, else standard — the card's default.
 */
export function lineChangeQuality(cell: CellData): ChangeVoiceQuality {
  const takeId = changeVoiceSourceTake(cell)?.audioId
  return changeVoiceQualityForSteps(takeId ? voiceChangedSteps(takeId) : null) ?? "standard"
}

export interface LineVoiceOptions {
  /** The line has words to read and the engine is reachable (the card's
   *  `canGenerate && offline gate ok`). */
  generateReady: boolean
  /** The take is the reference some voice was cloned from (AQU-2037):
   *  converting it would change that voice, so it is never re-voiced. */
  takeIsReference?: boolean
}

/**
 * What `voice` would do to the line's take — the card's `pendingFor`.
 * Null when it already sounds in that voice, or nothing can be done.
 */
export function lineVoiceActionFor(cell: CellData, voice: Voice, opts: LineVoiceOptions): LineVoiceAction | null {
  const take = lineTake(cell)
  if (!take.audioId) return opts.generateReady ? "generate" : null
  if (take.att?.voiceId === voice.id) return null
  const steps = CHANGE_VOICE_QUALITY_STEPS[lineChangeQuality(cell)]
  if (!opts.takeIsReference && changeVoiceBlocker(cell, voice, steps) == null) return "change"
  return opts.generateReady && !take.human ? "generate" : null
}

/** The line's cast voice, and whether anyone chose it (the card's `active`
 *  and `explicitVoice`). */
export function lineCastVoice(settings: ProjectTtsSettings | undefined, cell: CellData): { voice: Voice; explicit: boolean } {
  return {
    voice: resolveCastVoice(settings, cell, cell.ttsSettings?.voiceId),
    explicit: Boolean(findVoice(settings, assignedCastVoiceId(settings, cell) ?? cell.ttsSettings?.voiceId)),
  }
}

/**
 * The one-click that brings the line's take back to its cast voice, when the
 * two disagree — the card's `pending`, or its `humanPending` (a voice cast
 * over someone's recording, which only a click reads over). Null while the
 * line is being voiced, when nobody chose its voice, or when they agree.
 */
export function lineVoicePending(
  settings: ProjectTtsSettings | undefined,
  cell: CellData,
  opts: LineVoiceOptions & { canEdit: boolean; busy: boolean },
): { action: LineVoiceAction; voice: Voice } | null {
  const take = lineTake(cell)
  const { voice, explicit } = lineCastVoice(settings, cell)
  if (!take.audioId || !opts.canEdit || !explicit || opts.busy) return null
  const action = lineVoiceActionFor(cell, voice, opts)
  if (action) return { action, voice }
  if (take.human && opts.generateReady && take.att?.voiceId !== voice.id) return { action: "generate", voice }
  return null
}

/**
 * What a line nobody cast names its take, when that take is a person's —
 * the message key and its params. Null for a voice, or no take.
 */
export function lineTakeLabel(
  cell: CellData,
  username: string,
): { key: "editor.voice.originalAudio" } | { key: "editor.voice.recordedBy"; name: string } | { key: "editor.voice.yourRecording" } | null {
  const take = lineTake(cell)
  if (!take.human) return null
  if (take.isSourceClip) return { key: "editor.voice.originalAudio" }
  if (take.recordedBy && take.recordedBy !== username) return { key: "editor.voice.recordedBy", name: take.recordedBy }
  return { key: "editor.voice.yourRecording" }
}

/** The suggested name for a voice cloned from the line's take: who recorded
 *  it, or you for your own recording (the card's `suggestedName`). */
export function cloneNameSuggestion(cell: CellData, username: string): string {
  const take = lineTake(cell)
  return take.recordedBy ?? (take.human && !take.isSourceClip ? username : "")
}
