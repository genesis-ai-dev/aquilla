/**
 * Live back-translation: read a translation back as soon as this browser
 * drafts or saves it, when the project has turned it on
 * (`CompletionSettings.liveBacktranslation`).
 *
 * Only the browser that made the change reads it back — a save confirmed here
 * (`confirmCommitted`) is the trigger, never a remote edit arriving over sync —
 * so one edit costs one back-translation however many people have the file
 * open. The reading goes through the same path as the BT tab's Read back
 * button, so it is pinned, cached and synced exactly like one made by hand.
 *
 * This module owns the two decisions that are testable on their own: whether
 * a cell needs a fresh reading, and the queue that spaces the calls out.
 */

import type { CompletionSettings } from "@/lib/parsers/types"
import { isBacktranslationStale, type BacktranslationRecord } from "./bt-record"

/**
 * The settings a back-translation is read with: the drafting settings, with
 * the back-translation model in place of the drafting model when one is set.
 * Same provider, endpoint and key — only the model name changes.
 */
export function backtranslationSettings(settings: CompletionSettings): CompletionSettings {
  const model = settings.backtranslationModel?.trim()
  return model ? { ...settings, model } : settings
}

/**
 * Does this cell need a new live reading?
 *
 * - Nothing to read when the translation is empty.
 * - Nothing to do when the current reading already describes this text.
 * - A hand-corrected reading is never replaced automatically: it is left to
 *   show as out of date, and the person decides whether to refresh it.
 */
export function needsLiveBacktranslation(args: {
  translated: string
  targetEventId: string | undefined
  record: BacktranslationRecord | undefined
}): boolean {
  const { translated, targetEventId, record } = args
  if (!translated.trim()) return false
  if (!record?.btText.trim()) return true
  const stale = isBacktranslationStale({
    record,
    committedTranslated: translated,
    committedTargetEventId: targetEventId,
    visibleTranslated: translated,
  })
  if (!stale) return false
  return record.polished !== false
}

export interface LiveBtQueue {
  /** A save of `cellId` was confirmed; read it back once things settle. */
  notify(cellId: string, committedEventId?: string): void
  /** Drop everything waiting (file switch, setting turned off, unmount). */
  cancelAll(): void
}

export interface LiveBtQueueOptions {
  /** Read one cell back. Errors are the runner's to report. */
  run: (cellId: string, committedEventId: string | undefined) => Promise<void>
  /** Quiet period after the last save of a cell before it is read back. */
  delayMs?: number
  /** How many readings may be in flight at once. */
  concurrency?: number
}

export const LIVE_BT_DELAY_MS = 1200
export const LIVE_BT_CONCURRENCY = 2

/**
 * Debounced, bounded queue of live readings.
 *
 * Each cell waits `delayMs` after its last save, so a burst of saves to one
 * cell is read once. At most `concurrency` readings run together, so drafting
 * a whole chapter queues its readings behind the drafts instead of firing
 * them all at once. A cell saved again while its reading is in flight is read
 * once more afterwards, with the newest commit id.
 */
export function createLiveBtQueue(options: LiveBtQueueOptions): LiveBtQueue {
  const delayMs = options.delayMs ?? LIVE_BT_DELAY_MS
  const concurrency = Math.max(1, options.concurrency ?? LIVE_BT_CONCURRENCY)

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const latestEventId = new Map<string, string | undefined>()
  const waiting: string[] = []
  const running = new Set<string>()
  const again = new Set<string>()
  let generation = 0

  const pump = () => {
    while (running.size < concurrency && waiting.length > 0) {
      const cellId = waiting.shift()!
      start(cellId)
    }
  }

  const start = (cellId: string) => {
    const gen = generation
    running.add(cellId)
    const eventId = latestEventId.get(cellId)
    latestEventId.delete(cellId)
    void options.run(cellId, eventId)
      .catch(() => {})
      .finally(() => {
        running.delete(cellId)
        if (gen !== generation) return
        if (again.delete(cellId)) enqueue(cellId)
        pump()
      })
  }

  const enqueue = (cellId: string) => {
    if (running.has(cellId)) {
      again.add(cellId)
      return
    }
    if (!waiting.includes(cellId)) waiting.push(cellId)
    pump()
  }

  return {
    notify(cellId, committedEventId) {
      // Only the newest save's id: an older one would pin the reading to a
      // commit it no longer describes.
      latestEventId.set(cellId, committedEventId)
      const prev = timers.get(cellId)
      if (prev) clearTimeout(prev)
      timers.set(cellId, setTimeout(() => {
        timers.delete(cellId)
        enqueue(cellId)
      }, delayMs))
    },
    cancelAll() {
      generation++
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      latestEventId.clear()
      waiting.length = 0
      again.clear()
      // In-flight readings finish; their results are still checked against
      // the live text before they are kept.
      running.clear()
    },
  }
}
