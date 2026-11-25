/**
 * The offline sync adapter's side of a stall rescue (src/lib/sync/offline-stall-rescue.ts).
 *
 * A row rescued into IndexedDB isn't sent from the offline queue, but it stays
 * queued while IndexedDB's copy waits to upload, so the quit guard, update
 * gate and catch-up keep treating the edit as unsynced. Once that copy has left
 * the outbox the row is settled as the adapter's own POST would have been:
 * dequeued when accepted, dequeued with a conflict when stale, kept as
 * `failed` when refused (Retry and Discard are here). Otherwise a leader that
 * recovers after a rescue would persist rows nothing ever dequeues: "unsynced"
 * forever, and sent again on next launch.
 */

import type { Store } from "@livestore/livestore"
import {
  anyRescuedFromOfflineQueue,
  forgetRescuedFromOfflineQueue,
  isRescueCopyInFlight,
  markRescuedFromOfflineQueue,
  rescuedFromOfflineQueue,
  rescuedOutcome,
} from "@/lib/sync/offline-stall-rescue"
import type { OutboxLookup } from "@/lib/sync/offline-routing"
import { lookupOutboxIds, subscribeToOutbox } from "@/lib/sync/outbox"
import { events, tables, type schema } from "./schema"

/** The slice of the IndexedDB outbox (src/lib/sync/outbox.ts) the adapter reads. */
export interface RescueOutbox {
  /** Which of `ids` are still in the outbox, in any status. */
  has: OutboxLookup
  /** Called after any outbox change; returns an unsubscribe. */
  subscribe(cb: () => void): () => void
}

// Well under SQLite's bound-parameter limit.
const ID_LOOKUP_CHUNK = 500

export const indexedDbOutbox: RescueOutbox = { has: lookupOutboxIds, subscribe: subscribeToOutbox }

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

/** A queued row the server reported stale, for the adapter to mark its cell conflicted. */
export interface StaleRow {
  fileId: string | null
  cellId: string | null
  payload: unknown
}

export function createRescuedRows(
  store: Store<typeof schema>,
  projectId: string,
  outbox: RescueOutbox,
  onStale: (rows: readonly StaleRow[]) => void,
): RescuedRows {
  let stopped = false
  let running: Promise<void> | null = null
  let again = false

  async function adopt(): Promise<void> {
    const queued = store.query(tables.eventQueue.select("id").where({ projectId }))
    if (queued.length === 0) return
    const inOutbox = await outbox.has(queued)
    if (stopped || inOutbox.size === 0) return
    markRescuedFromOfflineQueue([...inOutbox].map((id) => ({ id, projectId })))
    release()
  }

  // Looks up only this project's rescued ids, not the whole queue: a rescued
  // row that never leaves the outbox keeps this running on every queue and
  // outbox change, including each status commit of a large flush.
  function queuedAmong(ids: readonly string[]): Set<string> {
    const found = new Set<string>()
    for (let i = 0; i < ids.length; i += ID_LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + ID_LOOKUP_CHUNK)
      const rows = store.query(tables.eventQueue.select("id").where({ projectId, id: { op: "IN", value: chunk } }))
      for (const id of rows) found.add(id)
    }
    return found
  }

  async function releaseOnce(): Promise<void> {
    if (stopped) return
    const mine = rescuedFromOfflineQueue(projectId)
    if (mine.length === 0) return
    // A rescued id no longer queued (its own POST went through before the
    // rescue, or a release already dequeued it) has nothing left to leave alone.
    const queued = queuedAmong(mine)
    forgetRescuedFromOfflineQueue(mine.filter((id) => !queued.has(id)))

    // A POST of the row that began before the rescue may still be in flight
    // (flushes hold rows in memory, not by status). Dequeuing under it is
    // harmless: its result's dequeue and status writes find no row.
    const rescued = [...queued]
      // A copy still being written isn't in the outbox yet, which would read
      // as "uploaded". Its outbox notification runs this again once it lands.
      .filter((id) => !isRescueCopyInFlight(id))
    if (rescued.length === 0) return
    const stillInOutbox = await outbox.has(rescued)
    if (stopped) return
    const stillQueued = queuedAmong(rescued)
    const settled = rescued.filter((id) => !stillInOutbox.has(id) && stillQueued.has(id))
    if (settled.length === 0) return
    const refused = settled.filter((id) => rescuedOutcome(id) === "refused")
    const dequeued = settled.filter((id) => rescuedOutcome(id) !== "refused")
    const stale = settled.filter((id) => rescuedOutcome(id) === "stale")
    const staleRows: StaleRow[] = []
    for (let i = 0; i < stale.length; i += ID_LOOKUP_CHUNK) {
      const chunk = stale.slice(i, i + ID_LOOKUP_CHUNK)
      staleRows.push(...store.query(
        tables.eventQueue.select("fileId", "cellId", "payload").where({ projectId, id: { op: "IN", value: chunk } }),
      ))
    }
    store.commit(
      ...(dequeued.length > 0 ? [events.eventsDequeued({ ids: dequeued })] : []),
      // Handed back: the adapter owns it again, as a refused write.
      ...refused.map((id) => events.eventQueueStatusSet({ id, status: "failed" })),
    )
    forgetRescuedFromOfflineQueue(settled)
    if (staleRows.length > 0) onStale(staleRows)
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
