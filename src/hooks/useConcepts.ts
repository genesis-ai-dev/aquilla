// Terminology concepts, read from the sync-worker projection. (AQU-1006 follow-up)
//
// Concepts used to be read off `project.terminology` — a key in the
// project_settings JSON blob. Every add rewrote that whole array from the
// writer's stale snapshot, so concurrent adds silently destroyed each other
// (2026-09-04: five people added terms on a demo call, one survived). They now
// live on the event log with their own projection; this hook is the read side.
//
// Thin-client (AD-3): plain `useState` + a race-guarded `useEffect`, fetching
// from sync-worker HTTP on demand. No React Query hooks — matching every other
// `*-read` hook in this codebase.

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchConcepts } from "@/lib/sync/concepts-read"
import type { Concept } from "@/lib/terminology/types"

export interface UseConceptsOptions {
  projectId: string | null
  /**
   * Token fetcher — same signature as `useComments`' `getToken`. Any
   * file-scoped sync-token for the project works: the concepts route verifies
   * the projectId only.
   */
  getToken?: (fileId: string) => Promise<string | null>
  /**
   * Auth-readiness signal (mirrors useComments' `tokenReady`, AQU-640). While
   * `false` the load is deferred rather than firing a fetch that would bail on
   * a null token and never retry.
   */
  tokenReady?: boolean
}

export interface UseConcepts {
  /** Every live concept for the project. Empty while loading or unavailable. */
  concepts: Concept[]
  isLoading: boolean
  error: string | null
  /** Re-read the projection. Call after a term.* write is acked. */
  refresh: () => Promise<void>
}

/** Stable empty array so consumers' memos keep identity across renders. */
const EMPTY: Concept[] = []

export function useConcepts(opts: UseConceptsOptions): UseConcepts {
  const { projectId, getToken, tokenReady } = opts
  const [concepts, setConcepts] = useState<Concept[]>(EMPTY)
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `getToken` is frequently an inline closure at the call site, so holding it
  // in a ref keeps `refresh` stable — otherwise every parent render would give
  // `refresh` a new identity and re-fire the load effect below.
  const tokenRef = useRef(getToken)
  useEffect(() => {
    tokenRef.current = getToken
  }, [getToken])

  // Race guard. A slower fetch for a PREVIOUS projectId must never overwrite a
  // newer one's results, which a bare `setConcepts` in an async body would do
  // on a fast project switch.
  const requestRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const seq = ++requestRef.current
    const settle = (fn: () => void) => {
      // Ignore a response that a newer request (or unmount) has superseded.
      if (aliveRef.current && requestRef.current === seq) fn()
    }
    if (!projectId) {
      settle(() => {
        setConcepts(EMPTY)
        setError(null)
      })
      return
    }
    setLoading(true)
    try {
      const fetchToken = tokenRef.current
      // Any file scope works — the route verifies the project only.
      const token = fetchToken ? await fetchToken("any") : null
      if (!token) {
        // FAIL CLOSED, and deliberately: reporting "no terms" as an empty list
        // with no error would compile to an empty rule set, silently switching
        // off every terminology check in the editor. An error keeps the
        // surface honest about not knowing.
        settle(() => {
          setConcepts(EMPTY)
          setError("no sync token for project")
        })
        return
      }
      const rows = await fetchConcepts(projectId, token)
      settle(() => {
        setConcepts(rows.length === 0 ? EMPTY : rows)
        setError(null)
      })
    } catch (e) {
      settle(() => setError(e instanceof Error ? e.message : String(e)))
    } finally {
      settle(() => setLoading(false))
    }
  }, [projectId])

  useEffect(() => {
    // Defer until the caller says a token can be minted; `tokenReady`
    // undefined means "don't wait" (the legacy behaviour for callers that
    // always have one).
    if (tokenReady === false) return
    void refresh()
  }, [refresh, tokenReady])

  return { concepts, isLoading, error, refresh }
}
