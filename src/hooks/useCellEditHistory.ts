import { useQuery } from "@tanstack/react-query"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

export interface UseCellEditHistoryOptions {
  enabled: boolean
  fileId: string | null
  cellId: string | null
  /** Limit; default 50, max 200 (server-clamped). */
  limit?: number
  getTokenForFile: (fileId: string) => Promise<string | null>
}

/** Reads the audit log for a single cell, server-ordered newest-first. */
export function useCellEditHistory(opts: UseCellEditHistoryOptions): {
  history: CellHistoryEntry[]
  isLoading: boolean
  isError: boolean
} {
  const { enabled, fileId, cellId, limit = 50, getTokenForFile } = opts

  const { data, isLoading, isError } = useQuery<CellHistoryEntry[]>({
    queryKey: ["cell-edit-history", fileId, cellId, limit],
    enabled: enabled && !!fileId && !!cellId,
    staleTime: 2_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const token = await getTokenForFile(fileId!)
      if (!token) {
        throw new Error("no-token")
      }
      const url = new URL(`${syncWorkerHttpOrigin()}/events`)
      url.searchParams.set("fileId", fileId!)
      url.searchParams.set("cellId", cellId!)
      url.searchParams.set("limit", String(limit))
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const body: {
        events: Array<{
          kind: string
          serverTs: number
          author: string
          payload: { value?: string }
        }>
      } = await res.json()

      // Filter to cell.commit events only, map to CellHistoryEntry
      const entries: CellHistoryEntry[] = body.events
        .filter((e) => e.kind === "cell.commit")
        .map((e) => ({
          timestamp: new Date(e.serverTs).toISOString(),
          value: e.payload.value ?? "",
          // source: not in event payload; default to "human" until LLM events land
          source: "human" as const,
          author: e.author,
          // validated: cell.commit events don't carry validation state;
          // validation comes from cell.validate events (deferred to Phase 4).
          validated: false,
        }))

      // Server returns newest-first; reverse to oldest-first for HistoryDrawer's
      // groupHistory() which expects chronological order.
      entries.reverse()

      return entries
    },
  })

  return {
    history: data ?? [],
    isLoading,
    isError,
  }
}
