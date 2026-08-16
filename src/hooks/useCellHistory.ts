// Phase 2c-γ: This module now hosts only the read-side `useCellHistory`
// React hook. The Y.Doc write helpers (appendCellHistory, validateCell,
// toggleCellValidation, setCellBacktranslation, recordHistoryEntry,
// dropLlmSeedHistory, etc.) were removed alongside the per-file Y.Doc.
//
// Validation has a parallel event-log path in EditorTable via
// `emitCellValidate` / `emitCellUnvalidate`. Backtranslation, multi-validator
// edit history, LLM-seed dropping, and free-form history recording are all
// v1.x deferred (see CLAUDE.md "Residual Y.Doc rip"). Don't add new
// writers here — write events through `lib/sync/events-emit.ts`.
//
// `useCellEditHistory` covers an overlapping concern with a different
// projection (cell.commit only, mapped to the legacy CellHistoryEntry
// shape used by HistoryDrawer). `useCellHistory` returns the raw event
// chain — every kind, parent pointer, payload — so a richer history view
// (or audit log) can render it directly.

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchCellHistory } from "@/lib/sync/history-read"
import type { CellHistoryEvent } from "@/lib/sync/history-read-types"

export interface UseCellHistoryOptions {
  projectId: string | null
  fileId: string | null
  cellId: string | null
  /** Server clamps to [1, 200]; default 50. */
  limit?: number
  getToken?: (fileId: string) => Promise<string | null>
  /** Disable the fetch (e.g. before identity loads / cell sheet closed). */
  enabled?: boolean
}

export interface UseCellHistoryResult {
  events: CellHistoryEvent[]
  revalidate: () => void
  isLoading: boolean
  isError: boolean
}

/**
 * Fetches the event chain for one cell on mount, on focus, and on
 * `revalidate()`. Same race-guarded refetch pattern as `useCells`
 * (generation counter ignores stale responses after a tuple change).
 */
export function useCellHistory(opts: UseCellHistoryOptions): UseCellHistoryResult {
  const {
    projectId,
    fileId,
    cellId,
    limit,
    getToken,
    enabled = true,
  } = opts

  const [events, setEvents] = useState<CellHistoryEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const cellRef = useRef(cellId)
  const limitRef = useRef(limit)
  const tokenFetcherRef = useRef(getToken)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  projectRef.current = projectId
  fileRef.current = fileId
  cellRef.current = cellId
  limitRef.current = limit
  tokenFetcherRef.current = getToken
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const fid = fileRef.current
    const cid = cellRef.current
    if (!enabledRef.current || !pid || !fid || !cid) {
      setEvents([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const fetchToken = tokenFetcherRef.current
      const token = fetchToken ? await fetchToken(fid) : null
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const rows = await fetchCellHistory(pid, fid, cid, token, { limit: limitRef.current })
      if (generationRef.current !== gen) return
      setEvents(rows)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellHistory] fetch failed:", err)
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

  return { events, revalidate, isLoading, isError }
}
