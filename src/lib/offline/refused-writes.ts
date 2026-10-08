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

/**
 * Calls `onDiscarded` for each refused target commit in this file that leaves
 * the queue — only Discard does that (an accepted write leaves from
 * pending/flushing; Retry moves it back to pending). The editor uses it to
 * drop the discarded text it was still showing (useActiveCellStore.ts).
 */
export function subscribeToDiscardedOfflineCommits(
  store: OfflineStore,
  projectId: string,
  fileId: string,
  onDiscarded: (cellId: string, value: string) => void,
): () => void {
  const query = tables.eventQueue.select().where({ projectId, fileId, kind: "target.cell.commit" })
  type Refused = { cellId: string; value: string }
  const refusedNow = (rows: readonly { id: string; status: string; cellId: string | null; payload: unknown }[]) => {
    const refused = new Map<string, Refused>()
    for (const row of rows) {
      const value = (row.payload as { value?: unknown } | null)?.value
      if (row.status === "failed" && row.cellId && typeof value === "string") refused.set(row.id, { cellId: row.cellId, value })
    }
    return refused
  }
  let refused = refusedNow(store.query(query))
  return store.subscribe(query, (rows) => {
    const present = new Set(rows.map((row) => row.id))
    for (const [id, { cellId, value }] of refused) {
      if (!present.has(id)) onDiscarded(cellId, value)
    }
    refused = refusedNow(rows)
  })
}
