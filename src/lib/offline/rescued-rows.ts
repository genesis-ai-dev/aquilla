/**
 * The offline sync adapter's side of a stall rescue (src/lib/sync/offline-stall-rescue.ts).
 *
 * A row rescued into IndexedDB isn't sent from the offline queue, but it stays
 * queued while IndexedDB's copy waits to upload, so the quit guard, update
 * gate and catch-up keep treating the edit as unsynced. Once that copy has left
 * the outbox (uploaded, or discarded) the row goes too. Otherwise a leader that
 * recovers after a rescue would persist rows nothing ever dequeues: "unsynced"
 * forever, and sent again on next launch.
 */

import type { Store } from "@livestore/livestore"
import {
  anyRescuedFromOfflineQueue,
  forgetRescuedFromOfflineQueue,
  isRescuedFromOfflineQueue,
  markRescuedFromOfflineQueue,
  rescuedFromOfflineQueue,
} from "@/lib/sync/offline-stall-rescue"
import { outboxHasIds, subscribeToOutbox } from "@/lib/sync/outbox"
import { events, tables, type schema } from "./schema"

/** The slice of the IndexedDB outbox (src/lib/sync/outbox.ts) the adapter reads. */
export interface RescueOutbox {
  /** Which of `ids` are still in the outbox, in any status. */
  has(ids: readonly string[]): Promise<ReadonlySet<string>>
  /** Called after any outbox change; returns an unsubscribe. */
  subscribe(cb: () => void): () => void
}

export const indexedDbOutbox: RescueOutbox = { has: outboxHasIds, subscribe: subscribeToOutbox }

export interface RescuedRows {
  /**
   * Re-marks queued rows that also have an IndexedDB copy: the rescued set
   * lives in page memory, so after a restart a row the leader did persist
   * would otherwise be sent by both queues. Run before the first flush.
   */
  adopt(): Promise<void>
  /** Dequeues rescued rows whose IndexedDB copy has left the outbox. Call on any queue or outbox change. */
  release(): void
  stop(): void
}

export function createRescuedRows(
  store: Store<typeof schema>,
  projectId: string,
  outbox: RescueOutbox,
): RescuedRows {
  let stopped = false
  let running: Promise<void> | null = null
  let again = false

  async function adopt(): Promise<void> {
    const queued = store.query(tables.eventQueue.select("id").where({ projectId }))
    if (queued.length === 0) return
    const inOutbox = await outbox.has(queued)
    if (stopped || inOutbox.size === 0) return
    markRescuedFromOfflineQueue(inOutbox)
    release()
  }

  async function releaseOnce(): Promise<void> {
    if (stopped || !anyRescuedFromOfflineQueue()) return
    // A rescued id no longer queued anywhere (its own POST went through
    // before the rescue, or a release already dequeued it) has nothing left
    // to leave alone. Unfiltered by project: the set is app-wide.
    const queuedAnywhere = new Set(store.query(tables.eventQueue.select("id")))
    forgetRescuedFromOfflineQueue(rescuedFromOfflineQueue().filter((id) => !queuedAnywhere.has(id)))

    // A POST of the row that began before the rescue may still be in flight
    // (flushes hold rows in memory, not by status). Dequeuing under it is
    // harmless: its result's dequeue and status writes find no row.
    const rescued = store
      .query(tables.eventQueue.select("id").where({ projectId }))
      .filter((id) => isRescuedFromOfflineQueue(id))
    if (rescued.length === 0) return
    const stillInOutbox = await outbox.has(rescued)
    if (stopped) return
    const stillQueued = new Set(store.query(tables.eventQueue.select("id").where({ projectId })))
    const uploaded = rescued.filter((id) => !stillInOutbox.has(id) && stillQueued.has(id))
    if (uploaded.length === 0) return
    store.commit(events.eventsDequeued({ ids: uploaded }))
    forgetRescuedFromOfflineQueue(uploaded)
  }

  function release(): void {
    if (stopped || !anyRescuedFromOfflineQueue()) return
    if (running) {
      again = true
      return
    }
    running = releaseOnce()
      .catch((err: unknown) => {
        // The next queue or outbox change tries again.
        console.warn("[offline] Couldn't release rows rescued to IndexedDB", err)
      })
      .finally(() => {
        running = null
        if (again) {
          again = false
          release()
        }
      })
  }

  return {
    adopt,
    release,
    stop: () => {
      stopped = true
    },
  }
}
