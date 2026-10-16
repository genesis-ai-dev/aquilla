// How many of a project's offline edits (Tauri LiveStore `event_queue`) are
// still on their way to the server, and how many it refused. The workspace's
// outbox chip only sees the IndexedDB outbox, so without these an offline-ready
// project's queued or refused edits read as "Synced".
import { useEffect, useState } from "react"
import type { Store } from "@livestore/livestore"
import { tables, type schema } from "./schema"

export interface OfflineQueueCounts {
  /** `pending` or `flushing` — will be sent. */
  pending: number
  /** Refused by the server; waits for Retry or Discard (refused-writes.ts). */
  failed: number
}

const NONE: OfflineQueueCounts = { pending: 0, failed: 0 }

export function countOfflineQueue(rows: readonly { status: string }[]): OfflineQueueCounts {
  let failed = 0
  for (const row of rows) if (row.status === "failed") failed += 1
  return { pending: rows.length - failed, failed }
}

export function useOfflineQueueCounts(
  store: Store<typeof schema> | null,
  projectId: string | null | undefined,
): OfflineQueueCounts {
  const [counts, setCounts] = useState<{ key: string; value: OfflineQueueCounts } | null>(null)

  useEffect(() => {
    if (!store || !projectId) return
    const query = tables.eventQueue.select("status").where({ projectId })
    const key = projectId
    const update = (statuses: readonly string[]) => {
      const value = countOfflineQueue(statuses.map((status) => ({ status })))
      setCounts((prev) =>
        prev?.key === key && prev.value.pending === value.pending && prev.value.failed === value.failed
          ? prev
          : { key, value },
      )
    }
    return store.subscribe(query, update)
  }, [store, projectId])

  // Ignore counts left over from a previous store/project until the new subscription reports.
  return store && projectId && counts?.key === projectId ? counts.value : NONE
}
