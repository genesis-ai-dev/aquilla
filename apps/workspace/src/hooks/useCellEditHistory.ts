// Phase 2b: cell edit history (legacy CellHistoryEntry projection).
//
// Overlap with useCellHistory: both fetch the same event log via the
// sync-worker, but this hook returns the narrower legacy shape consumed
// by HistoryDrawer (one entry per `*.cell.commit` event, mapped to
// `{timestamp, value, source, author, validated}`). useCellHistory exposes
// the raw event chain for callers that need parent pointers / payloads /
// non-commit kinds. Phase 2c collapses both into one when the audit + drawer
// surfaces have aligned.
//
// Compared to the pre-Phase 2b implementation:
//   - dropped @tanstack/react-query dependency in favor of the Phase 2a
//     pattern (vanilla useState + race-guarded effect)
//   - now goes through `fetchCellHistory` (server returns AD-2-prefixed
//     kinds; we filter to `*.cell.commit` to preserve the old drawer's
//     "value history only" view)

import { useCallback, useEffect, useRef, useState } from "react"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { fetchCellHistory } from "@/lib/sync/history-read"
import type { CellHistoryEvent } from "@/lib/sync/history-read-types"

export interface UseCellEditHistoryOptions {
  enabled: boolean
  /** Project the cell belongs to. New in Phase 2b: server reads need the
   *  projectId for the sync-token / DB scope. Callers wire this from the
   *  active project. */
  projectId: string | null
  fileId: string | null
  cellId: string | null
  /** Server clamps to [1, 200]; default 50. */
  limit?: number
  getTokenForFile: (fileId: string) => Promise<string | null>
}

export interface UseCellEditHistoryResult {
  history: CellHistoryEntry[]
  isLoading: boolean
  isError: boolean
  revalidate: () => void
}

function mapEventsToEntries(events: CellHistoryEvent[]): CellHistoryEntry[] {
  // Filter to `*.cell.commit` events — drawer renders value history, not
  // file/project lifecycle events. Server returns newest-first; reverse
  // for HistoryDrawer.groupHistory() which expects chronological.
  const entries: CellHistoryEntry[] = []
  for (const e of [...events].reverse()) {
    if (e.kind !== "target.cell.commit" && e.kind !== "source.cell.commit") continue
    const payload = e.payload as { value?: string } | null
    entries.push({
      timestamp: new Date(e.serverTs).toISOString(),
      value: payload?.value ?? "",
      source: "human",
      author: e.author,
      validated: false,
    })
  }
  return entries
}

export function useCellEditHistory(opts: UseCellEditHistoryOptions): UseCellEditHistoryResult {
  const { enabled, projectId, fileId, cellId, limit, getTokenForFile } = opts

  const [history, setHistory] = useState<CellHistoryEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const cellRef = useRef(cellId)
  const limitRef = useRef(limit)
  const tokenFetcherRef = useRef(getTokenForFile)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  projectRef.current = projectId
  fileRef.current = fileId
  cellRef.current = cellId
  limitRef.current = limit
  tokenFetcherRef.current = getTokenForFile
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const fid = fileRef.current
    const cid = cellRef.current
    if (!enabledRef.current || !pid || !fid || !cid) {
      setHistory([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const token = await tokenFetcherRef.current(fid)
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const rows = await fetchCellHistory(pid, fid, cid, token, { limit: limitRef.current })
      if (generationRef.current !== gen) return
      setHistory(mapEventsToEntries(rows))
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellEditHistory] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, cellId, enabled, limit])

  useEffect(() => {
    if (typeof window === "undefined") return
    function onFocus() { void doFetch() }
    function onVis() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void doFetch()
      }
    }
    window.addEventListener("focus", onFocus)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis)
    }
    return () => {
      window.removeEventListener("focus", onFocus)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis)
      }
    }
  }, [doFetch])

  const revalidate = useCallback(() => {
    void doFetch()
  }, [doFetch])

  return { history, isLoading, isError, revalidate }
}
