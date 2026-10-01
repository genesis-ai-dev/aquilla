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
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

export interface PersistTakeTrimInput {
  projectId: string
  /** The file of the cell that HOLDS the take — a linked heard-line take lives
   *  on a cue in the hidden sibling file, not on the row showing it. */
  fileId: string
  cellId: string
  audioId: string
  att: Pick<CodexCellAttachment, "url" | "slot" | "voiceId" | "referenceAudioId" | "durationMs" | "validatorCount" | "validators">
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
  injectOptimisticAudioTrim(fileId, cellId, {
    audioId,
    url: att.url,
    slot,
    mimeType: null,
    voiceId: att.voiceId ?? null,
    referenceAudioId: att.referenceAudioId ?? null,
    durationMs: att.durationMs ?? null,
    // AQU-490: the overlay REPLACES the attachment rather than merging into it,
    // so a field left out here is one the editor stops seeing while the shadow
    // lives — the line would flicker to unvalidated on every trim.
    ...(att.validatorCount != null ? { validatorCount: att.validatorCount } : {}),
    ...(att.validators ? { validators: att.validators } : {}),
    trimStartMs,
    trimEndMs,
  }, trimP)
  notifyAudioAttachmentsChanged(fileId)
  return trimP
}

/** Seconds (null = edge) to the event's whole milliseconds. */
export function trimMs(sec: number | null): number | null {
  return sec == null ? null : Math.round(sec * 1000)
}
