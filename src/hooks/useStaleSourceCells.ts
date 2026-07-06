// Phase 5 / AD-9. Fetches the set of cell ids whose source has advanced
// since the translator's last commit (the AD-9 pointer-comparison query
// run server-side). Extended FRO-476 §6/§7: also surfaces tombstoned cell
// ids + the link-level `behindSeq` probe, and fires the mirror sync
// lazy-pull trigger (POST /link/sync, fire-and-forget) alongside the
// stale-source fetch — the cheap place to catch a dormant live-linked
// project up when its file is opened.
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
  fetchStaleSourceResponse,
  StaleSourceError,
} from "@/lib/sync/stale-source-read"
import type { BehindSeq } from "@/lib/sync/stale-source-read-types"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

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
  /** FRO-476: membership set of cell ids whose upstream source was deleted. */
  tombstonedCellIds: ReadonlySet<string>
  /** FRO-476: link-level "you have unmirrored upstream changes" probe. */
  behindSeq: BehindSeq | null
  isLoading: boolean
  isError: boolean
  /** Manual refetch — call after target commits or known upstream edits. */
  revalidate: () => void
}

// SWARM-TODO(FRO-476): verify the lazy-pull trigger end to end — create
// project A (import a small USFM), create project B linked live to A via
// POST /api/v2/projects/:B/link-source { sourceProjectId: A, mode: 'live' },
// open a file in B in the app (or call useStaleSourceCells directly) and
// confirm (via network tab / a DB read) that
// POST /api/v1/projects/:B/link/sync fires and B's source cells populate.

/** Fire-and-forget mirror sync trigger — never blocks the stale-source
 *  fetch, never surfaces an error to the UI (self-healing: the next file
 *  open or the cursor probe on any read catches anything missed). */
function triggerLinkSync(projectId: string, jwt: string): void {
  const url = `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/link/sync`
  void fetch(url, { method: "POST", headers: { Authorization: `Bearer ${jwt}` } }).catch(() => {
    /* best-effort; the next lazy-pull trigger or manual sync catches it */
  })
}

export function useStaleSourceCells(
  opts: UseStaleSourceCellsOptions,
): UseStaleSourceCellsResult {
  const { projectId, fileId, getToken, enabled = true } = opts
  const [staleCellIds, setStaleCellIds] =
    useState<ReadonlySet<string>>(EMPTY)
  const [tombstonedCellIds, setTombstonedCellIds] =
    useState<ReadonlySet<string>>(EMPTY)
  const [behindSeq, setBehindSeq] = useState<BehindSeq | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const generationRef = useRef(0)
  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const enabledRef = useRef(enabled)
  const tokenRef = useRef(getToken)
  const tokenRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tokenAttemptsRef = useRef(0)
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
      setTombstonedCellIds(EMPTY)
      setBehindSeq(null)
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
        // Auth race — retry with backoff rather than reporting error. After
        // ~6 attempts give up; staleness is a soft signal so empty-but-quiet
        // is the right fallback.
        const attempt = ++tokenAttemptsRef.current
        if (attempt >= 6) {
          setStaleCellIds(EMPTY)
          setTombstonedCellIds(EMPTY)
          setBehindSeq(null)
          setIsLoading(false)
          setIsError(false)
          return
        }
        const delay = Math.min(4000, 250 * 2 ** (attempt - 1))
        if (tokenRetryRef.current) clearTimeout(tokenRetryRef.current)
        tokenRetryRef.current = setTimeout(() => {
          tokenRetryRef.current = null
          if (generationRef.current === gen) void doFetch()
        }, delay)
        return
      }
      tokenAttemptsRef.current = 0
      // FRO-476 §7: lazy-pull trigger, fire-and-forget, alongside the
      // stale-source fetch (not awaited — never delays the read).
      triggerLinkSync(pid, jwt)
      const body = await fetchStaleSourceResponse(pid, fid, jwt)
      if (generationRef.current !== gen) return
      setStaleCellIds(new Set(body.staleCellIds ?? []))
      setTombstonedCellIds(new Set(body.tombstonedCellIds ?? []))
      setBehindSeq(body.behindSeq ?? null)
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
      setTombstonedCellIds(EMPTY)
      setBehindSeq(null)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, enabled])

  useEffect(() => () => {
    if (tokenRetryRef.current) {
      clearTimeout(tokenRetryRef.current)
      tokenRetryRef.current = null
    }
  }, [])

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

  return { staleCellIds, tombstonedCellIds, behindSeq, isLoading, isError, revalidate: doFetch }
}
