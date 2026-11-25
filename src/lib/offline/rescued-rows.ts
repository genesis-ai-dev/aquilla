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
  isRescueCopyInFlight,
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

// Well under SQLite's bound-parameter limit.
const ID_LOOKUP_CHUNK = 500

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

  // Looks up only the rescued ids, not the whole queue: a rescued row that
  // never leaves the outbox (quarantined) keeps this running on every queue
  // and outbox change, including each status commit of a large flush.
  function queuedAmong(ids: readonly string[], where: { projectId?: string } = {}): Set<string> {
    const found = new Set<string>()
    for (let i = 0; i < ids.length; i += ID_LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + ID_LOOKUP_CHUNK)
      const rows = store.query(tables.eventQueue.select("id").where({ ...where, id: { op: "IN", value: chunk } }))
      for (const id of rows) found.add(id)
    }
    return found
  }

  async function releaseOnce(): Promise<void> {
    if (stopped || !anyRescuedFromOfflineQueue()) return
    // A rescued id no longer queued anywhere (its own POST went through
    // before the rescue, or a release already dequeued it) has nothing left
    // to leave alone. Unfiltered by project: the set is app-wide.
    const allRescued = rescuedFromOfflineQueue()
    const queuedAnywhere = queuedAmong(allRescued)
    forgetRescuedFromOfflineQueue(allRescued.filter((id) => !queuedAnywhere.has(id)))

    // A POST of the row that began before the rescue may still be in flight
    // (flushes hold rows in memory, not by status). Dequeuing under it is
    // harmless: its result's dequeue and status writes find no row.
    const rescued = [...queuedAmong(rescuedFromOfflineQueue(), { projectId })]
      // A copy still being written isn't in the outbox yet, which would read
      // as "uploaded". Its outbox notification runs this again once it lands.
      .filter((id) => isRescuedFromOfflineQueue(id) && !isRescueCopyInFlight(id))
    if (rescued.length === 0) return
    const stillInOutbox = await outbox.has(rescued)
    if (stopped) return
    const stillQueued = queuedAmong(rescued, { projectId })
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
