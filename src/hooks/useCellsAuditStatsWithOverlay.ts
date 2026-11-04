import { useMemo, useState } from "react"
import { useCellsAuditStats, type CellAuditStats } from "./useCellsAuditStats"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { usePendingOutboxRecords } from "./usePendingOutboxRecords"
import type { OutboxRecord } from "@/lib/sync/outbox"
import {
  applyOutboxOverlay,
  pendingCellIds,
  reconcileFlushShadows,
  type FlushShadowState,
} from "@/lib/sync/audit-stats-overlay"

interface UseCellsAuditStatsWithOverlayOptions {
  enabled: boolean
  fileId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
  lane?: string
}

const EMPTY_SHADOWS: FlushShadowState = new Map()
const EMPTY_IDS: ReadonlySet<string> = new Set()

interface OverlaySnapshot {
  base: ReadonlyMap<string, CellAuditStats>
  pending: ReadonlyArray<OutboxRecord>
  failedCellIds: ReadonlySet<string>
  lane: string
  fileId: string
  shadows: FlushShadowState
  prevPendingCellIds: ReadonlySet<string>
  prevOverlaid: ReadonlyMap<string, CellAuditStats> | null
  out: ReadonlyMap<string, CellAuditStats>
}

/**
 * Combines server (Postgres) audit stats with the client outbox so users see their own
 * pending commits/validations immediately, before the next 30s refetch.
 *
 * Pending events are filtered to the active fileId — the outbox can hold
 * events for many files, but the stats view is per-file. Subscription-based
 * via the outbox in-process notifier (see usePendingOutboxRecords).
 *
 * A flushed record's overlay is pinned as a shadow until the server map's
 * entry for that cell is refetched, so the pill does not flash back to the
 * pre-click state in the gap between the IDB delete and the targeted GET
 * (see `reconcileFlushShadows`).
 */
export function useCellsAuditStatsWithOverlay(
  opts: UseCellsAuditStatsWithOverlayOptions,
): {
  byCellId: Map<string, CellAuditStats>
  complete: boolean
  isLoading: boolean
  isError: boolean
  revalidate: () => void
  revalidateCellStats: (cellId: string) => void
  applyCommittedCellStats: (cellId: string, rows: readonly CellRow[]) => boolean
} {
  const { byCellId: base, complete, isLoading, isError, revalidate, revalidateCellStats, applyCommittedCellStats } = useCellsAuditStats(opts)

  // `includeFailed` so a record that was QUARANTINED can be told apart from
  // one that FLUSHED: only the latter earns a shadow. Quarantined records are
  // split out below and never reach the overlay (AQU-274).
  const records = usePendingOutboxRecords({
    enabled: !!opts.fileId,
    fileId: opts.fileId,
    includeFailed: true,
  })
  const { pending, failedCellIds } = useMemo(() => {
    const pending = records.filter((r) => (r.status ?? "pending") !== "failed")
    const failedCellIds = new Set<string>()
    for (const r of records) {
      if ((r.status ?? "pending") === "failed" && r.event.cellId) failedCellIds.add(r.event.cellId)
    }
    return { pending, failedCellIds }
  }, [records])

  const lane = opts.lane ?? ""

  // Shadow bookkeeping across renders, kept as "state derived from the previous
  // render" (the React-documented pattern, so the compiler and the refs rule
  // are both satisfied): recompute only when an input changes, and store the
  // inputs alongside so the render-time setState settles in one pass.
  const [snap, setSnap] = useState<OverlaySnapshot | null>(null)
  const fileId = opts.fileId ?? ""
  let out: ReadonlyMap<string, CellAuditStats>
  if (
    snap &&
    snap.base === base && snap.pending === pending && snap.failedCellIds === failedCellIds &&
    snap.lane === lane && snap.fileId === fileId
  ) {
    out = snap.out
  } else {
    const overlaid = pending.length === 0 ? base : applyOutboxOverlay({ base, pending, lane })
    // A view switch (file or lane) drops every shadow: the map it was pinned
    // against is gone.
    const sameView = !!snap && snap.fileId === fileId && snap.lane === lane
    const r = reconcileFlushShadows({
      base,
      pending,
      failedCellIds,
      overlaid,
      prevPendingCellIds: sameView ? snap.prevPendingCellIds : EMPTY_IDS,
      prevOverlaid: sameView ? snap.prevOverlaid : null,
      prev: sameView ? snap.shadows : EMPTY_SHADOWS,
    })
    out = r.out
    setSnap({
      base, pending, failedCellIds, lane, fileId,
      shadows: r.shadows, prevPendingCellIds: pendingCellIds(pending), prevOverlaid: r.out, out: r.out,
    })
  }
  const byCellId = out as Map<string, CellAuditStats>

  return { byCellId, complete, isLoading, isError, revalidate, revalidateCellStats, applyCommittedCellStats }
}
