import { useQuery } from "@tanstack/react-query"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

export interface CellAuditStats {
  cellId: string
  editCount: number
  contentHash: string
  /** Server clock at the cell's most recent commit. null when the cell hasn't been
   *  projected from a CQRS event yet (e.g. legacy Y.Doc-only seeded rows). */
  lastEditAt: number | null
  /** UUIDv7 of the cell.commit event that produced the current value. Carry this
   *  on validate/unvalidate events so the validator binds to the right edit. */
  lastEditEventId: string | null
  /** Active validators tied to lastEditEventId. Empty when the current edit has
   *  no approvals or when lastEditEventId is null. */
  activeValidators: string[]
}

interface UseCellsAuditStatsOptions {
  enabled: boolean
  fileId: string | null
  /** Same shape as Phase 2 outbox flusher uses. */
  getTokenForFile: (fileId: string) => Promise<string | null>
}

/**
 * Fetches /cells/audit-stats for a file. Returns a map keyed by cellId
 * for O(1) lookup from per-cell call sites (CellActionsMenu, useCompositeHealth,
 * useCells validation derivation).
 *
 * Stale-while-revalidate via React Query — UI updates on Realtime
 * `projection.dirty` invalidation by re-fetching; in this phase we just
 * use a 30s polling refetch as a safety net since the WS broadcast
 * wiring on the client isn't connected yet.
 */
export function useCellsAuditStats(opts: UseCellsAuditStatsOptions): {
  byCellId: Map<string, CellAuditStats>
  isLoading: boolean
  isError: boolean
} {
  const { enabled, fileId, getTokenForFile } = opts

  const { data, isLoading, isError } = useQuery<Map<string, CellAuditStats>>({
    queryKey: ["cells-audit-stats", fileId],
    enabled: enabled && !!fileId,
    staleTime: 5_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const token = await getTokenForFile(fileId!)
      if (!token) {
        throw new Error("no-token")
      }
      const url = `${syncWorkerHttpOrigin()}/cells/audit-stats?fileId=${encodeURIComponent(fileId!)}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const body: { cells: Partial<CellAuditStats>[] } = await res.json()
      const map = new Map<string, CellAuditStats>()
      for (const row of body.cells) {
        if (!row.cellId) continue
        map.set(row.cellId, {
          cellId: row.cellId,
          editCount: row.editCount ?? 0,
          contentHash: row.contentHash ?? "",
          lastEditAt: row.lastEditAt ?? null,
          lastEditEventId: row.lastEditEventId ?? null,
          activeValidators: row.activeValidators ?? [],
        })
      }
      return map
    },
  })

  return {
    byCellId: data ?? new Map(),
    isLoading,
    isError,
  }
}
