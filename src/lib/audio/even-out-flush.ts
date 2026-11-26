// AQU-2664: send Even out's writes before the action ends. One outbox flush
// posts at most one batch (100 events of one file), so a 300-take run would
// leave 200 to the background flusher; this flushes round after round until
// the action's own events are out (outbox-flush.ts `flushOutboxUntilSettled`).
// A flush that fails (offline) leaves them queued: the outbox sends them when
// it can, and the takes already show evened out on this device.

import { flushOutboxUntilSettled, type FlushDeps } from "@/lib/sync/outbox-flush"

/** The most events one outbox flush posts (outbox-flush.ts MAX_BATCH). */
export const OUTBOX_BATCH = 100

export async function flushEvenOutWrites(
  eventIds: readonly string[],
  deps: FlushDeps,
  settle: typeof flushOutboxUntilSettled = flushOutboxUntilSettled,
): Promise<void> {
  if (eventIds.length === 0) return
  try {
    await settle(eventIds, deps, { maxRounds: Math.ceil(eventIds.length / OUTBOX_BATCH) + 2 })
  } catch {
    // Queued and kept: sent when the network allows.
  }
}
