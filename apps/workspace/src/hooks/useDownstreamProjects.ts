// Phase 5 / AD-9. Lists the projects whose source_project_id points at
// :projectId — i.e. the linked-target projects downstream of the subject.
//
// Used by:
//   - source-only / upstream project settings ("3 linked targets")
//   - the (future) archive / delete confirmation flow
//   - the Dashboard's "downstream count" badge
//
// Pattern follows Phase 2a: plain useState + race-guarded effect + manual
// `refresh()`. No subscription — the upstream surface for source-link
// mutations is project-lead-only, low-cardinality, and not worth wiring
// a realtime channel for.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchProjectDownstreams,
  SourceLinkingError,
} from "@/lib/sync/source-linking-read"
import type { DownstreamProject } from "@/lib/sync/source-linking-read-types"

export interface UseDownstreamProjectsOptions {
  projectId: string | null
  /** Provides the auth-worker JWT; null disables the fetch. */
  getToken?: () => string | null
  /** Set false to skip the fetch (e.g. before identity loads). */
  enabled?: boolean
}

export interface UseDownstreamProjectsResult {
  downstreams: DownstreamProject[]
  isLoading: boolean
  isError: boolean
  /** Manual refetch after a known mutation (link / detach / delete). */
  refresh: () => void
}

export function useDownstreamProjects(
  opts: UseDownstreamProjectsOptions,
): UseDownstreamProjectsResult {
  const { projectId, getToken, enabled = true } = opts
  const [downstreams, setDownstreams] = useState<DownstreamProject[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const generationRef = useRef(0)
  const projectRef = useRef(projectId)
  const enabledRef = useRef(enabled)
  const tokenRef = useRef(getToken)
  projectRef.current = projectId
  enabledRef.current = enabled
  tokenRef.current = getToken

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const enabled = enabledRef.current
    const getToken = tokenRef.current
    if (!enabled || !pid) {
      setDownstreams([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const jwt = getToken?.()
      if (!jwt) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const list = await fetchProjectDownstreams(pid, jwt)
      if (generationRef.current !== gen) return
      setDownstreams(list)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      // 403 from a user without access is expected — surface as empty, not error.
      if (err instanceof SourceLinkingError && err.status === 403) {
        setDownstreams([])
        setIsLoading(false)
        return
      }
      console.warn("[useDownstreamProjects] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled])

  return {
    downstreams,
    isLoading,
    isError,
    refresh: doFetch,
  }
}
