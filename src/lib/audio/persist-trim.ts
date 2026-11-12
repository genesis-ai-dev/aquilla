// Saving a take's trim, from anywhere. (AQU-1210 / AQU-1217, 2026-09-25)
//
// Until now two surfaces each carried their own copy of this: the timeline's
// chip edge drag (ProjectWorkspace.handleTrimTarget) and the Audio view's crop
// popover (CellVoicePanel). Trimming now also happens in place on the
// Recording tab and the Audio view card, so it lives here once.
//
// THE ATTACHMENT IS THE ONLY RECORD OF A TRIM. The Audio view used to keep its
// own copy in a per-device, per-LINE preference and hydrate it from the
// server, which meant switching a line to another take carried the old take's
// trim across. Every reader now takes the window from the attachment, and this
// is the one way to change it: the `cell.audio.trim` event (both ends always
// stated; null = back to the clip's edge) plus an optimistic overlay that
// paints the new window at once and lives exactly as long as the event.

import { emitCellAudioTrim } from "@/lib/sync/events-emit"
import { injectOptimisticAudioTrim, notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { attachmentOutFrom } from "@/lib/audio/cut-take"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

export interface PersistTakeTrimInput {
  projectId: string
  /** The file of the cell that HOLDS the take — a linked heard-line take lives
   *  on a cue in the hidden sibling file, not on the row showing it. */
  fileId: string
  cellId: string
  audioId: string
  /** The take as the caller reads it, whole: the overlay is made from it. */
  att: Omit<CodexCellAttachment, "type">
  /** The owner's recorded selection, only to infer a slot the clip lacks. */
  selectedAudioId?: string
  trimStartMs: number | null
  trimEndMs: number | null
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  author: string
}

/** Paint the new window, emit it, and tell every reader of the file. Resolves
 *  with the event id once the event is queued. */
export function persistTakeTrim(input: PersistTakeTrimInput): Promise<string> {
  const { projectId, fileId, cellId, audioId, att, trimStartMs, trimEndMs, author } = input
  // AQU-646: the clip's own slot; the comparison is only a fallback for a clip
  // that reached us without one.
  const slot = att.slot ?? (audioId === input.selectedAudioId ? "recording" : "generatedVoice")
  const trimP = emitCellAudioTrim({
    projectId, fileId, cellId, audioId, trimStartMs, trimEndMs, author,
    ...(input.targetLang ? { targetLang: input.targetLang } : {}),
  })
  // AQU-2495 (review, Nov 12): the overlay holds the new window alone,
  // painted over the take as the read has it, and yields as soon as the read
  // carries the window. A copy of the whole take stood in for it before: a
  // hand-picked one left out the name and place (a Recording-tab trim renamed
  // "Music bed" to "Take 1", and the next trim's floor read no place), and a
  // full one (Nov 11) hid a rename, move or level change made meanwhile for
  // up to 12 s. The whole take (`attachmentOutFrom`) is painted only while no
  // read has it yet.
  injectOptimisticAudioTrim(fileId, cellId, {
    ...attachmentOutFrom(audioId, { type: "audio", ...att }, slot),
    trimStartMs,
    trimEndMs,
  }, trimP, { ownFields: true })
  notifyAudioAttachmentsChanged(fileId)
  return trimP
}

/** Seconds (null = edge) to the event's whole milliseconds. */
export function trimMs(sec: number | null): number | null {
  return sec == null ? null : Math.round(sec * 1000)
}
