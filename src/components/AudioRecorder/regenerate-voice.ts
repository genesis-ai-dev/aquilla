// AQU-1767 (Sam, 2026-10-14): one way to regenerate a line's voice, shared by
// the recorder's TTS button and the timeline take's right-click menu, so both
// name the new take the same way and both make it the one that sounds.

import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { audioIdSeededWith } from "@/lib/audio/upload"
import { emitCellAudioDeselect, emitCellAudioSelect } from "@/lib/sync/events-emit"
import {
  injectOptimisticAudioAttachment,
  injectOptimisticAudioDeselect,
  notifyAudioAttachmentsChanged,
} from "@/lib/audio/audio-attachments-bus"
import { GENERATED_VOICE_SLOT, isDefaultTrackSlot, slotsForTrack, trackIdForSlot } from "@/lib/timeline/track-slots"
import { withGroup } from "@/lib/history/history"
import { playingInSlot, recordSlotChoice } from "@/lib/history/take-steps"
import { nextTakeLabel } from "./TakesStrip"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { TelemetrySurface } from "@/lib/cell-telemetry"

export interface RegenerateVoiceArgs {
  project: ProjectRecord
  /** The line the takes hang on (a cue, on a file with an audio-cue sibling). */
  cell: CellData
  /** That line's takes in this lane, as the attachments read returns them. */
  entry: CellAudioEntry | undefined
  session: FrontierSession
  username: string
  /** The track's storage slot the voice lands on. */
  targetSlot: string
  /** AQU-1462: the lane the member is working in; absent for the default lane. */
  laneTag?: string | null
  /** The words to speak, when they are not the cell's own (see `readAloudFor`). */
  text?: string
  /** Whose cast voice says them, when it is not the cell's own assignment. */
  voiceCellId?: string | null
  surface: TelemetrySurface
}

/**
 * Generate a new voice take for one line and make it the one that sounds.
 * Resolves false when there is nothing to say or the generation failed; the
 * failure itself is written to the per-cell TTS status by `generateCellVoice`.
 *
 * Decision 11: ONE Undo step — the new take, and the recording it stopped
 * from sounding.
 */
export function regenerateVoiceTake(args: RegenerateVoiceArgs): Promise<boolean> {
  return withGroup({ labelKey: "editor.history.stepGenerateVoice", fileId: args.cell.fileId }, () => regenerate(args))
}

async function regenerate(args: RegenerateVoiceArgs): Promise<boolean> {
  const { project, cell, entry, session, username, targetSlot, laneTag } = args
  const attachments = Object.values(entry?.attachments ?? {})
  // The takes on THIS track, the source clip excluded: what "Take N" counts.
  const ownSlots = new Set(slotsForTrack(trackIdForSlot(targetSlot)))
  const takes = attachments
    .filter((a) => ownSlots.has(a.slot))
    .filter((a) => !audioIdSeededWith(a.audioId, cell.fileId))
  // The source clip itself — the recording slot's "no take" state.
  const sourceClip = attachments.find((a) => a.slot === "recording" && audioIdSeededWith(a.audioId, cell.fileId)) ?? null

  // Round 8c: the TTS take is born with its permanent name like any take.
  const ok = await generateCellVoice({
    project, cell, session, username,
    surface: args.surface,
    label: nextTakeLabel(takes),
    // The WORDS come from the subtitle this line performs, and the VOICE from
    // that subtitle's cast assignment — neither of which a cue carries itself.
    // Both undefined off a cue file: the cell's own text and assignment.
    text: args.text,
    voiceCellId: args.voiceCellId ?? undefined,
    // The voice lands on the track asked for, not always on the default row's
    // generated-voice slot.
    slot: isDefaultTrackSlot(targetSlot) ? undefined : targetSlot,
    ...(laneTag ? { targetLang: laneTag } : {}),
    history: {
      selectedBefore: playingInSlot(entry, isDefaultTrackSlot(targetSlot) ? GENERATED_VOICE_SLOT : targetSlot),
    },
  })
  if (!ok) return false

  // You asked for this voice — make it the one that sounds. A recorded take
  // holding the recording slot would shadow it, so hand the slot back to the
  // source clip (the "no take" state), or empty it where there is none.
  //
  // THE DEFAULT TRACK ONLY: an added track's recorded and generated takes are
  // siblings in one slot, so picking either deselects the other through the
  // per-(cell, slot) rule the server already enforces.
  const recSel = isDefaultTrackSlot(targetSlot) ? entry?.selectedAudioId : null
  if (recSel && audioIdSeededWith(recSel, cell.id)) {
    const where = {
      projectId: project.id, fileId: cell.fileId, cellId: cell.id, slot: "recording", author: username,
      ...(laneTag ? { targetLang: laneTag } : {}),
    }
    const displaceP = sourceClip
      ? emitCellAudioSelect({ ...where, audioId: sourceClip.audioId })
      : emitCellAudioDeselect(where)
    if (sourceClip) injectOptimisticAudioAttachment(cell.fileId, cell.id, sourceClip, displaceP)
    else injectOptimisticAudioDeselect(cell.fileId, cell.id, "recording", displaceP)
    await displaceP
    notifyAudioAttachmentsChanged(cell.fileId)
    recordSlotChoice(
      { cellId: cell.id, slot: "recording", before: playingInSlot(entry, "recording"), after: sourceClip?.audioId ?? null },
      { fileId: cell.fileId },
    )
  }
  return true
}
