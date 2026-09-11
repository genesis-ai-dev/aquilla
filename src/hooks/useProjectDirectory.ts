import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import {
  getPortfolioPage,
  getPortfoliosPage,
  PORTFOLIO_PAGE_SIZE,
  type PortfolioProject,
} from "@/lib/frontier/portfolio"

export const PROJECT_DIRECTORY_SEARCH_DEBOUNCE_MS = 200

export type DirectoryProject = PortfolioProject & {
  orgId?: number
}

/**
 * Paged project directory for org / all-orgs tables. Search hits the server
 * (debounced); scroll calls `loadMore` with the keyset cursor.
 */
export function useProjectDirectory(opts: {
  jwt: string | null
  enabled: boolean
  query: string
  orgIds: number[]
  refreshKey?: number
}): {
  projects: DirectoryProject[]
  loading: boolean
  /** True while the typed query is debouncing or a directory page is in flight. */
  searching: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
} {
  const { jwt, enabled, query, orgIds, refreshKey = 0 } = opts
  const orgKey = useMemo(
    () => [...new Set(orgIds)].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b).join(","),
    [orgIds],
  )
  const scopedIds = useMemo(
    () => (orgKey ? orgKey.split(",").map((id) => Number(id)) : []),
    [orgKey],
  )
  const debouncedQuery = useDebouncedValue(query, PROJECT_DIRECTORY_SEARCH_DEBOUNCE_MS)
  const fetchKey = `${enabled}:${jwt}:${orgKey}:${debouncedQuery}:${refreshKey}`
  const [projects, setProjects] = useState<DirectoryProject[]>([])
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const nextCursorRef = useRef<string | null>(null)
  const loadingMoreRef = useRef(false)
  nextCursorRef.current = nextCursor
  const needsFetch = Boolean(enabled && jwt && scopedIds.length > 0)
  const loading = needsFetch && settledKey !== fetchKey

  useLayoutEffect(() => {
    if (!enabled || !jwt || scopedIds.length === 0) {
      setProjects([])
      setNextCursor(null)
      setError(null)
      setSettledKey(fetchKey)
      setLoadingMore(false)
      return
    }

    const controller = new AbortController()
    const requestId = ++requestIdRef.current
    setError(null)
    setLoadingMore(false)
    loadingMoreRef.current = false

    void (async () => {
      try {
        const page = await fetchDirectoryPage(jwt, scopedIds, {
          q: debouncedQuery,
          signal: controller.signal,
        })
        if (requestIdRef.current !== requestId) return
        setProjects(page.projects)
        setNextCursor(page.nextCursor)
        setSettledKey(fetchKey)
      } catch (e) {
        if (controller.signal.aborted) return
        if (requestIdRef.current !== requestId) return
        setProjects([])
        setNextCursor(null)
        setError(e instanceof Error ? e.message : String(e))
        setSettledKey(fetchKey)
      }
    })()

    return () => {
      controller.abort()
    }
  }, [enabled, jwt, scopedIds, debouncedQuery, refreshKey, fetchKey])

  const loadMore = useCallback(() => {
    if (!enabled || !jwt || scopedIds.length === 0) return
    const cursor = nextCursorRef.current
    if (!cursor || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const requestId = requestIdRef.current
    void (async () => {
      try {
        const page = await fetchDirectoryPage(jwt, scopedIds, {
          q: debouncedQuery,
          cursor,
        })
        if (requestIdRef.current !== requestId) return
        setProjects((prev) => mergeProjects(prev, page.projects))
        setNextCursor(page.nextCursor)
      } catch (e) {
        if (requestIdRef.current !== requestId) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (requestIdRef.current === requestId) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        }
      }
    })()
  }, [enabled, jwt, scopedIds, debouncedQuery])

  return {
    projects,
    loading,
    searching: needsFetch && (query !== debouncedQuery || loading),
    loadingMore,
    error,
    hasMore: nextCursor != null,
    loadMore,
  }
}

function fetchDirectoryPage(
  jwt: string,
  orgIds: number[],
  opts: { q: string; cursor?: string | null; signal?: AbortSignal },
) {
  const pageOpts = {
    q: opts.q,
    limit: PORTFOLIO_PAGE_SIZE,
    cursor: opts.cursor,
    signal: opts.signal,
  }
  if (orgIds.length === 1) {
    return getPortfolioPage(jwt, orgIds[0]!, pageOpts)
  }
  return getPortfoliosPage(jwt, orgIds, pageOpts)
}

function mergeProjects(
  prev: DirectoryProject[],
  incoming: DirectoryProject[],
): DirectoryProject[] {
  if (incoming.length === 0) return prev
  const seen = new Set(prev.map((p) => p.id))
  const extra = incoming.filter((p) => !seen.has(p.id))
  return extra.length === 0 ? prev : [...prev, ...extra]
}
