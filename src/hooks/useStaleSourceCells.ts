// Phase 5 / AD-9. Fetches the set of cell ids whose source has advanced
// since the translator's last commit (the AD-9 pointer-comparison query
// run server-side).
//
// Returns a Set for O(1) membership; consumers (`StaleSourceIndicator`,
// future cell-row integration) call `.has(cellId)` per cell.
//
// `revalidate()` lets parents trigger a refetch after a known mutation
// (e.g. a target commit, or an upstream source edit that we observed).
// The 2c-β editor rewrite will wire this into the cell-row render path;
// for Phase 5 we expose the hook and the indicator component but defer
// per-cell wiring until 2c-β lands.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchStaleSourceCells,
  StaleSourceError,
} from "@/lib/sync/stale-source-read"

const EMPTY: ReadonlySet<string> = new Set()

export interface UseStaleSourceCellsOptions {
  projectId: string | null
  fileId: string | null
  /** Mints a sync-token JWT scoped to (projectId, fileId). Same shape
   *  as `useCells` so callers reuse a single token fetcher. */
  getToken?: (fileId: string) => Promise<string | null>
  /** Disable the fetch (e.g. before identity loads). */
  enabled?: boolean
}

export interface UseStaleSourceCellsResult {
  /** Membership set of cell ids whose source has advanced since commit. */
  staleCellIds: ReadonlySet<string>
  isLoading: boolean
  isError: boolean
  /** Manual refetch — call after target commits or known upstream edits. */
  revalidate: () => void
}

export function useStaleSourceCells(
  opts: UseStaleSourceCellsOptions,
): UseStaleSourceCellsResult {
  const { projectId, fileId, getToken, enabled = true } = opts
  const [staleCellIds, setStaleCellIds] =
    useState<ReadonlySet<string>>(EMPTY)
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const generationRef = useRef(0)
  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const enabledRef = useRef(enabled)
  const tokenRef = useRef(getToken)
  projectRef.current = projectId
  fileRef.current = fileId
  enabledRef.current = enabled
  tokenRef.current = getToken

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const fid = fileRef.current
    const enabled = enabledRef.current
    const getToken = tokenRef.current
    if (!enabled || !pid || !fid) {
      setStaleCellIds(EMPTY)
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const jwt = getToken ? await getToken(fid) : null
      if (!jwt) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const ids = await fetchStaleSourceCells(pid, fid, jwt)
      if (generationRef.current !== gen) return
      setStaleCellIds(new Set(ids))
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      // Staleness is a soft signal; on transient errors fall back to
      // "nothing is stale" rather than freezing the editor.
      if (err instanceof StaleSourceError) {
        console.warn("[useStaleSourceCells] fetch failed:", err.status, err.body)
      } else {
        console.warn("[useStaleSourceCells] fetch failed:", err)
      }
      setStaleCellIds(EMPTY)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, enabled])

  // Refetch on window focus — same drift mitigation pattern as `useCells`.
  // When a peer commits an upstream source edit the indicator should
  // appear without the user manually reloading.
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

  return { staleCellIds, isLoading, isError, revalidate: doFetch }
}
