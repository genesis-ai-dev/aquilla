import { useQuery } from "@tanstack/react-query"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

export interface CellAuditStats {
  cellId: string
  editCount: number
  contentHash: string
}

interface UseCellsAuditStatsOptions {
  enabled: boolean
  fileId: string | null
  /** Same shape as Phase 2 outbox flusher uses. */
  getTokenForFile: (fileId: string) => Promise<string | null>
}

/**
 * Fetches /cells/audit-stats for a file. Returns a map keyed by cellId
 * for O(1) lookup from per-cell call sites (CellActionsMenu, useCompositeHealth).
 *
 * Stale-while-revalidate via React Query — UI updates on Realtime
 * `projection.dirty` invalidation by re-fetching; in this phase we just
 * use a 30s polling refetch as a safety net since the WS broadcast
 * wiring on the client isn't connected yet (Phase 4 work).
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
      const body: { cells: CellAuditStats[] } = await res.json()
      const map = new Map<string, CellAuditStats>()
      for (const row of body.cells) {
        map.set(row.cellId, row)
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
