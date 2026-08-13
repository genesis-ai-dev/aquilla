import { useMemo } from "react"
import { useCellsAuditStats, type CellAuditStats } from "./useCellsAuditStats"
import { usePendingOutboxRecords } from "./usePendingOutboxRecords"
import { applyOutboxOverlay } from "@/lib/sync/audit-stats-overlay"

interface UseCellsAuditStatsWithOverlayOptions {
  enabled: boolean
  fileId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
}

/**
 * Combines server (Postgres) audit stats with the client outbox so users see their own
 * pending commits/validations immediately, before the next 30s refetch.
 *
 * Pending events are filtered to the active fileId — the outbox can hold
 * events for many files, but the stats view is per-file. Subscription-based
 * via the outbox in-process notifier (see usePendingOutboxRecords).
 */
export function useCellsAuditStatsWithOverlay(
  opts: UseCellsAuditStatsWithOverlayOptions,
): {
  byCellId: Map<string, CellAuditStats>
  isLoading: boolean
  isError: boolean
  revalidate: () => void
  revalidateCellStats: (cellId: string) => void
} {
  const { byCellId: base, isLoading, isError, revalidate, revalidateCellStats } = useCellsAuditStats(opts)

  const pending = usePendingOutboxRecords({
    enabled: !!opts.fileId,
    fileId: opts.fileId,
  })

  const byCellId = useMemo(() => {
    if (pending.length === 0) return base
    return applyOutboxOverlay({ base, pending })
  }, [base, pending])

  return { byCellId, isLoading, isError, revalidate, revalidateCellStats }
}
