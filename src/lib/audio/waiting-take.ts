// AQU-2426 (review, Nov 9): a take recorded over the hourly limit survives a
// reload.
//
// A take saved while the hosted limit is used up waits and transcribes by
// itself once the limit allows (`waitAtTranscribeLimit`). That wait was in
// memory only: reload or close the tab during it (it can be 15 minutes) and
// the take stayed "Not transcribed" for good, the outcome AQU-2426 set out to
// remove. So while a take waits it is kept as a one-row transcription run
// (transcribe-runs.ts, AQU-2375): the page that opens its file next, signed in
// as the same person with the same language open, carries it on like any run
// a reload stopped. A take that never meets the limit keeps nothing.

import { pageIsLeaving, startStoredTranscribeRun, type TranscribeRunHandle } from "./transcribe-runs"
import { waitAtTranscribeLimit } from "./transcribe-status"

/** Where the waiting take is, so the next page can find and transcribe it. */
export interface WaitingTakeKeep {
  projectId: string
  fileId: string
  /** Names the run in the toast that says it was carried on. */
  fileName: string
  cellId: string
  /** Who recorded it; only they carry it on. */
  username?: string
  /** The language lane it was recorded in ("" = the default lane). */
  lane: string
  /** That lane's language, which the transcription is told. */
  targetLanguage?: string
}

export function waitingTake(args: {
  audioId: string
  /** null: not kept (signed out, or a take the batch can't find again). */
  keep: WaitingTakeKeep | null
  /** @internal test seam. */
  sleep?: (ms: number) => Promise<void>
}): {
  /** Hand to `transcribeCell`'s `onRateLimited`. */
  onRateLimited: (retryAfterSeconds: number) => Promise<void>
  /** The take's transcription ended, either way. */
  settled: () => void
} {
  let handle: TranscribeRunHandle | null = null
  return {
    onRateLimited: async (retryAfterSeconds) => {
      const { keep } = args
      if (!handle && keep) {
        handle = startStoredTranscribeRun({
          id: `take-${args.audioId}-${Date.now().toString(36)}`,
          projectId: keep.projectId,
          fileId: keep.fileId,
          fileName: keep.fileName,
          // The rows someone chose: carried on without a banner of its own.
          kind: "sections",
          cellIds: [keep.cellId],
          force: false,
          ...(keep.username ? { username: keep.username } : {}),
          lane: keep.lane,
          ...(keep.lane ? { targetLang: keep.lane } : {}),
          ...(keep.targetLanguage ? { targetLanguage: keep.targetLanguage } : {}),
        })
      }
      await waitAtTranscribeLimit(args.audioId, args.sleep)(retryAfterSeconds)
    },
    settled: () => {
      // The page is going: the take stays kept, and the next page transcribes it.
      if (pageIsLeaving()) return
      handle?.end()
      handle = null
    },
  }
}
