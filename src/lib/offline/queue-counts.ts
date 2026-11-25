// How many of a project's offline edits (Tauri LiveStore `event_queue`) are
// still on their way to the server, and how many it refused. The workspace's
// outbox chip only sees the IndexedDB outbox, so without these an offline-ready
// project's queued or refused edits read as "Synced".
import { useEffect, useState } from "react"
import type { Store } from "@livestore/livestore"
import { isRescuedFromOfflineQueue, subscribeRescuedFromOfflineQueue } from "@/lib/sync/offline-stall-rescue"
import { tables, type schema } from "./schema"

export interface OfflineQueueCounts {
  /** `pending` or `flushing` — will be sent. */
  pending: number
  /** Refused by the server; waits for Retry or Discard (refused-writes.ts). */
  failed: number
}

const NONE: OfflineQueueCounts = { pending: 0, failed: 0 }

/**
 * A row rescued into the IndexedDB outbox when the leader stalled
 * (offline-stall-rescue.ts) is left out: it stays queued until IndexedDB's
 * copy uploads, and that copy is already counted as an outbox record.
 */
export function countOfflineQueue(rows: readonly { id: string; status: string }[]): OfflineQueueCounts {
  let pending = 0
  let failed = 0
  for (const row of rows) {
    if (isRescuedFromOfflineQueue(row.id)) continue
    if (row.status === "failed") failed += 1
    else pending += 1
  }
  return { pending, failed }
}

export function useOfflineQueueCounts(
  store: Store<typeof schema> | null,
  projectId: string | null | undefined,
): OfflineQueueCounts {
  const [counts, setCounts] = useState<{ key: string; value: OfflineQueueCounts } | null>(null)

  useEffect(() => {
    if (!store || !projectId) return
    const query = tables.eventQueue.select("id", "status").where({ projectId })
    const key = projectId
    let latest: readonly { id: string; status: string }[] = []
    const update = (rows: readonly { id: string; status: string }[]) => {
      latest = rows
      const value = countOfflineQueue(rows)
      setCounts((prev) =>
        prev?.key === key && prev.value.pending === value.pending && prev.value.failed === value.failed
          ? prev
          : { key, value },
      )
    }
    const unsubscribeQueue = store.subscribe(query, update)
    const unsubscribeRescued = subscribeRescuedFromOfflineQueue(() => update(latest))
    return () => {
      unsubscribeQueue()
      unsubscribeRescued()
    }
  }, [store, projectId])

  // Ignore counts left over from a previous store/project until the new subscription reports.
  return store && projectId && counts?.key === projectId ? counts.value : NONE
}
