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

/**
 * Reactive view of pending outbox records for the inspector UI. Refreshes via
 * the outbox in-process subscription so the list updates the moment a user
 * action enqueues an event, and the moment the flusher removes one.
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
      const scoped = fileId ? all.filter((r) => r.event.fileId === fileId) : all
      setRecords(scoped.slice(0, maxResults))
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
