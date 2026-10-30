/**
 * Takes that an Undo has just taken back (decision 11: recording, uploading
 * and generating are undoable).
 *
 * A fresh recording is transcribed in the background, and the transcript
 * lands as a RE-ATTACH of the same take — which the projection treats as
 * "this take is live and chosen" (`deleted = 0, selected = 1`). Undo a
 * recording before its transcript arrives and the re-attach would bring it
 * straight back. The transcription asks here first and drops its re-attach
 * for a take the person has undone; a Redo takes the mark off again.
 *
 * In memory, for this tab: the window it guards is the seconds a
 * transcription takes.
 */
const undone = new Set<string>()

export function markTakeUndone(audioId: string): void {
  undone.add(audioId)
}

export function clearTakeUndone(audioId: string): void {
  undone.delete(audioId)
}

export function wasTakeUndone(audioId: string): boolean {
  return undone.has(audioId)
}
