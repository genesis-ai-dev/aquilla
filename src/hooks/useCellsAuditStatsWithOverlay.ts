import { useEffect, useMemo, useState } from "react"
import { useCellsAuditStats, type CellAuditStats } from "./useCellsAuditStats"
import { peekOutboxBatch, subscribeToOutbox, type OutboxRecord } from "@/lib/sync/outbox"
import { applyOutboxOverlay } from "@/lib/sync/audit-stats-overlay"

interface UseCellsAuditStatsWithOverlayOptions {
  enabled: boolean
  fileId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
}

/**
 * Combines D1 audit stats with the client outbox so users see their own
 * pending commits/validations immediately, before the next 30s refetch.
 *
 * Pending events are filtered to the active fileId — the outbox can hold
 * events for many files, but the stats view is per-file. Polling is
 * subscription-based: enqueue/remove inside outbox.ts notifies, the hook
 * refreshes its pending-records snapshot, the memo recomputes the overlay.
 */
export function useCellsAuditStatsWithOverlay(
  opts: UseCellsAuditStatsWithOverlayOptions,
): {
  byCellId: Map<string, CellAuditStats>
  isLoading: boolean
  isError: boolean
} {
  const { byCellId: base, isLoading, isError } = useCellsAuditStats(opts)

  const { fileId } = opts
  const [pending, setPending] = useState<OutboxRecord[]>([])

  useEffect(() => {
    if (!fileId) {
      setPending([])
      return
    }
    let cancelled = false

    async function refresh() {
      // peekOutboxBatch is oldest-first; limit large but bounded so a runaway
      // outbox doesn't ruin a refresh. The outbox is intended to be drained
      // continuously, so 5000 is well above any realistic backlog.
      const all = await peekOutboxBatch(5000)
      if (cancelled) return
      const scoped = all.filter((r) => r.event.fileId === fileId)
      setPending(scoped)
    }

    refresh()
    const unsub = subscribeToOutbox(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [fileId])

  const byCellId = useMemo(() => {
    if (pending.length === 0) return base
    return applyOutboxOverlay({ base, pending })
  }, [base, pending])

  return { byCellId, isLoading, isError }
}
