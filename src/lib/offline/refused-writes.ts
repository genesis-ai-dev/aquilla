// Queued offline writes the server refused for good (a 4xx other than 401 —
// role lowered, lane deleted, a payload it won't take). The sync adapter keeps
// them as `failed` rather than dropping them (sync-adapter.ts), and the user
// decides: retry (e.g. once access is restored) or discard.
import type { Store } from "@livestore/livestore"
import { events, tables, type schema } from "./schema"

type OfflineStore = Store<typeof schema>

export const refusedWritesQuery = tables.eventQueue.select("id").where({ status: "failed" })

export function countRefusedWrites(store: OfflineStore): number {
  return store.query(refusedWritesQuery).length
}

/** Puts every refused write back in line; the sync adapter's queue subscription sends it. */
export function retryRefusedWrites(store: OfflineStore): void {
  for (const id of store.query(refusedWritesQuery)) {
    store.commit(events.eventQueueStatusSet({ id, status: "pending" }))
  }
}

/** Drops every refused write from the queue. Irreversible — the edits are gone. */
export function discardRefusedWrites(store: OfflineStore): void {
  for (const id of store.query(refusedWritesQuery)) {
    store.commit(events.eventDequeued({ id }))
  }
}
