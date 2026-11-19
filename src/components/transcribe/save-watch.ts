// Did a Transcribe row's save reach the server?
//
// A row no longer waits for its save to be flushed before it moves on
// (AQU-2654): the new text is on screen the moment the write is queued, and
// the app's outbox flusher delivers it. Most failures the flusher retries by
// itself. One it has given up on — refused by the server, or out of attempts —
// leaves the record in the outbox marked `failed`, and the take keeps the
// words the server has. This watches for that, so the row can say its save did
// not land instead of quietly going back to the old text.
//
// It reads the outbox (IndexedDB), never the network, and only while a write
// of this view's is unaccounted for.

import { getOutboxFileAudioRecords, subscribeToOutbox } from "@/lib/sync/outbox"

/** How long outbox notifications are gathered before one look at the queue. */
export const SAVE_WATCH_DELAY_MS = 400

export interface TranscriptWriteWatch {
  /** A words write for this line was queued by an action that began at
   *  `since`. An older stuck write of the same line is not this action's. */
  note(fileId: string, cellId: string, since: number): void
  /** Forget every write being watched (the view is going away). */
  stop(): void
}

export function watchTranscriptWrites(opts: {
  projectId: string
  /** The line's write will not be sent again by itself. */
  onFailed: (cellId: string, detail: string | undefined) => void
}): TranscriptWriteWatch {
  /** Writes not yet seen delivered or failed, by cell. */
  const open = new Map<string, { fileId: string; since: number }>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  /** Bumped by `stop`, so a look already under way reports nothing. */
  let generation = 0

  const check = async () => {
    timer = null
    const mine = generation
    for (const fileId of new Set([...open.values()].map((write) => write.fileId))) {
      const records = await getOutboxFileAudioRecords(opts.projectId, fileId)
      if (mine !== generation) return
      for (const [cellId, write] of [...open]) {
        if (write.fileId !== fileId) continue
        const words = records.filter((record) =>
          record.event.cellId === cellId
          && record.event.kind === "cell.audio.attach"
          && record.enqueuedAt >= write.since
          && (record.event.payload as { wordsOnly?: unknown } | null)?.wordsOnly === true)
        const failed = words.find((record) => record.status === "failed")
        if (failed) {
          open.delete(cellId)
          opts.onFailed(cellId, failed.lastError ? `${failed.lastError.status} ${failed.lastError.reason}`.trim() : undefined)
        } else if (words.length === 0) {
          // Left the queue: delivered.
          open.delete(cellId)
        }
      }
    }
    if (open.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }

  const schedule = () => {
    if (timer !== null || open.size === 0) return
    timer = setTimeout(() => void check(), SAVE_WATCH_DELAY_MS)
  }

  return {
    note(fileId, cellId, since) {
      const earlier = open.get(cellId)
      open.set(cellId, { fileId, since: earlier ? Math.min(earlier.since, since) : since })
      unsubscribe ??= subscribeToOutbox(schedule)
      schedule()
    },
    stop() {
      generation += 1
      if (timer !== null) clearTimeout(timer)
      timer = null
      unsubscribe?.()
      unsubscribe = null
      open.clear()
    },
  }
}
