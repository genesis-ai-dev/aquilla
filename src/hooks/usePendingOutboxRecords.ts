import { useEffect, useState } from "react"
import { peekOutboxBatch, subscribeToOutbox, type OutboxRecord } from "@/lib/sync/outbox"

interface Options {
  /** When false, returns empty and does not subscribe. */
  enabled: boolean
  /** Filter to events for this file. null = no filter (returns all pending). */
  fileId: string | null
  /** Hard cap on records returned to the UI; the IDB read uses 2× this so the
   *  filter doesn't starve when many other-file events are pending. Default 500. */
  maxResults?: number
}

function outboxRecordKey(record: OutboxRecord): string {
  return JSON.stringify({
    id: record.id,
    status: record.status,
    attempts: record.attempts,
    lastAttemptAt: record.lastAttemptAt,
    lastError: record.lastError,
    eventId: record.event.id,
    kind: record.event.kind,
    projectId: record.event.projectId,
    fileId: record.event.fileId,
    cellId: record.event.cellId,
    payload: record.event.payload,
  })
}

function recordsEqual(a: readonly OutboxRecord[], b: readonly OutboxRecord[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (outboxRecordKey(a[i]) !== outboxRecordKey(b[i])) return false
  }
  return true
}

/**
 * Reactive view of PENDING (non-quarantined) outbox records for overlay
 * consumers (audit-stats overlay). Refreshes via the outbox in-process
 * subscription so the list updates the moment a user action enqueues an
 * event, and the moment the flusher removes one.
 *
 * AQU-274: `failed` (quarantined) records are excluded so the overlay does
 * not replay a rejected commit/validate as live cell state. The outbox
 * inspector should call `peekOutboxBatch` directly to get all statuses.
 */
export function usePendingOutboxRecords(opts: Options): OutboxRecord[] {
  const { enabled, fileId, maxResults = 500 } = opts
  const [records, setRecords] = useState<OutboxRecord[]>([])

  useEffect(() => {
    if (!enabled) {
      setRecords([])
      return
    }
    let cancelled = false

    async function refresh() {
      const all = await peekOutboxBatch(maxResults * 2)
      if (cancelled) return
      // AQU-274: exclude quarantined records from the overlay so failed events
      // don't show as pending validation/commit state. Inspector views should
      // use peekOutboxBatch directly to preserve visibility of failed records.
      const active = all.filter((r) => (r.status ?? "pending") !== "failed")
      const scoped = fileId ? active.filter((r) => r.event.fileId === fileId) : active
      const next = scoped.slice(0, maxResults)
      setRecords((prev) => recordsEqual(prev, next) ? prev : next)
    }

    refresh()
    const unsub = subscribeToOutbox(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [enabled, fileId, maxResults])

  return records
}
