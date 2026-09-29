// Deleting and renaming a take, one way everywhere: the recorder's takes list,
// the Recording tab's list, and the take that plays at the top of the tab (Sam,
// 2026-09-29: deletable "even if it's the only take that exists", and
// renameable when it is the selected one).

import { emitCellAudioRemove, emitCellAudioRename } from "@/lib/sync/events-emit"
import { injectOptimisticAudioRemove, notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { audioIdSeededWith } from "@/lib/audio/upload"

/**
 * Remove one take. SUB-48: the remove gets its own overlay, so the take leaves
 * the screen now and stays gone for as long as its event sits in the outbox —
 * and a still-queued attach for the same clip cannot paint it back. Rejects
 * when the emit fails; the overlay drops itself and pokes a refetch, so the
 * take reappears from server truth rather than the UI wedging.
 */
export async function removeTake(args: {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  /** The take's OWN slot, verbatim — never coerced (see TakesStrip's circle). */
  slot: string
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  author: string
}): Promise<void> {
  const { projectId, fileId, cellId, audioId, slot, author, targetLang } = args
  const removeP = emitCellAudioRemove({ projectId, fileId, cellId, audioId, author, ...(targetLang ? { targetLang } : {}) })
  injectOptimisticAudioRemove(fileId, cellId, audioId, slot, removeP)
  await removeP
  notifyAudioAttachmentsChanged(fileId)
}

/**
 * Give a take its permanent name (round 8: names are persisted, never derived
 * from position). Rejects when the emit fails, so a caller showing the new name
 * early can put the old one back.
 */
export async function renameTake(args: {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  label: string
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  author: string
}): Promise<void> {
  await emitCellAudioRename(args)
  notifyAudioAttachmentsChanged(args.fileId)
}

/**
 * Does the cell still hold a RECORDING of its own once `removedId` is gone?
 * "A recording" is a non-synthetic take (no `voiceId`) on any track, seeded
 * with this cell's id — the imported source clip, seeded with the file's, is
 * never one. When the answer is no, the workspace resets the target row the
 * recordings justified (onLastTakeRemoved).
 */
export function hasOwnRecordingLeft(
  takes: Iterable<{ audioId: string; voiceId?: string | null; isDeleted?: boolean }>,
  removedId: string,
  cellId: string,
): boolean {
  for (const t of takes) {
    if (t.audioId === removedId || t.isDeleted || t.voiceId) continue
    if (audioIdSeededWith(t.audioId, cellId)) return true
  }
  return false
}
