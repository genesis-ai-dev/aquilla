import { useEffect, useRef, useState } from "react"
import { peekOutboxBatch, readOutboxCounts, subscribeToOutbox, type OutboxRecord } from "@/lib/sync/outbox"
import { recordsEqual } from "@/hooks/usePendingOutboxRecords"

/** Rows read per notification. A longer queue is counted with a second read. */
const READ_LIMIT = 1000
/** Cap on each list handed to the UI (the same cap usePendingOutboxRecords uses). */
const VIEW_LIMIT = 500

export interface OutboxSnapshot {
  /** Total records in the outbox (pending + failed). */
  pendingCount: number
  /** Records that permanently failed / were quarantined. */
  failedCount: number
  /** PENDING records only (AQU-274): safe for overlays and drain logic. */
  records: OutboxRecord[]
  /** All statuses (SUB-9): for the inspector only. */
  inspectorRecords: OutboxRecord[]
}

interface Options {
  /** When false, nothing is read: the lists are empty and the counts are the flusher's. */
  enabled: boolean
  /** The flusher's own counts. They are the fallback while disabled, and a
   *  change in them that this hook has not seen (another tab drained the
   *  queue, which sends no in-process notification) asks for a re-read. */
  flusherPendingCount: number
  flusherFailedCount: number
}

const NO_RECORDS: OutboxRecord[] = []
const EMPTY: OutboxSnapshot = { pendingCount: 0, failedCount: 0, records: NO_RECORDS, inspectorRecords: NO_RECORDS }

/**
 * The outbox as OutboxProvider publishes it: both record lists and both counts
 * from ONE read per outbox notification, applied in ONE state update.
 *
 * Before, the provider took the counts from the flusher and each list from its
 * own `usePendingOutboxRecords` read. Three reads settle in three tasks, so one
 * acked commit changed the context value three times and rendered every
 * consumer of `useOutbox()` — the whole project workspace — three times with
 * values that disagreed in between (0 pending, 2 records).
 */
export function useOutboxSnapshot(options: Options): OutboxSnapshot {
  const { enabled, flusherPendingCount, flusherFailedCount } = options
  const [snapshot, setSnapshot] = useState<OutboxSnapshot>(EMPTY)
  const publishedRef = useRef(EMPTY)
  const refreshRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled) {
      publishedRef.current = EMPTY
      setSnapshot(EMPTY)
      return
    }
    let cancelled = false
    let inFlight = false
    let again = false

    async function refresh() {
      // One read at a time. A request that arrives during a read asks for one
      // more after it, because the read in flight may predate the change.
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      try {
        do {
          again = false
          const all = await peekOutboxBatch(READ_LIMIT)
          const counts = all.length < READ_LIMIT
            ? { count: all.length, failed: all.filter((r) => r.status === "failed").length }
            : await readOutboxCounts().catch(() => ({ count: all.length, failed: all.filter((r) => r.status === "failed").length }))
          if (cancelled) return
          const prev = publishedRef.current
          const records = all.filter((r) => (r.status ?? "pending") !== "failed").slice(0, VIEW_LIMIT)
          const inspectorRecords = all.slice(0, VIEW_LIMIT)
          const next: OutboxSnapshot = {
            pendingCount: counts.count,
            failedCount: counts.failed,
            records: recordsEqual(prev.records, records) ? prev.records : records,
            inspectorRecords: recordsEqual(prev.inspectorRecords, inspectorRecords) ? prev.inspectorRecords : inspectorRecords,
          }
          if (
            next.pendingCount !== prev.pendingCount
            || next.failedCount !== prev.failedCount
            || next.records !== prev.records
            || next.inspectorRecords !== prev.inspectorRecords
          ) {
            publishedRef.current = next
            setSnapshot(next)
          }
        } while (again)
      } finally {
        inFlight = false
      }
    }

    refreshRef.current = () => void refresh()
    void refresh()
    const unsubscribe = subscribeToOutbox(() => void refresh())
    return () => {
      cancelled = true
      refreshRef.current = null
      unsubscribe()
    }
  }, [enabled])

  useEffect(() => {
    const published = publishedRef.current
    if (published.pendingCount !== flusherPendingCount || published.failedCount !== flusherFailedCount) {
      refreshRef.current?.()
    }
  }, [flusherPendingCount, flusherFailedCount])

  if (!enabled) {
    return { pendingCount: flusherPendingCount, failedCount: flusherFailedCount, records: NO_RECORDS, inspectorRecords: NO_RECORDS }
  }
  return snapshot
}
