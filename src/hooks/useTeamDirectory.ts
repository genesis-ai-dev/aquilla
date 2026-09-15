import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import {
  listTeamsPage,
  TEAM_DIRECTORY_PAGE_SIZE,
  type TeamDirectoryVisibility,
  type TeamSummary,
} from "@/lib/frontier/teams"

export const TEAM_DIRECTORY_SEARCH_DEBOUNCE_MS = 200

/**
 * Paged team directory for `/orgs/:id/teams`. Search hits the server
 * (debounced); scroll calls `loadMore` with the name-keyset cursor.
 * Visibility is part of the fetch key so Internal/Public replace the page.
 */
export function useTeamDirectory(opts: {
  jwt: string | null
  enabled: boolean
  orgId: number | null
  query: string
  visibility: TeamDirectoryVisibility
  refreshKey?: number
}): {
  teams: TeamSummary[]
  loading: boolean
  /** True while the typed query is debouncing or a directory page is in flight. */
  searching: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
} {
  const { jwt, enabled, orgId, query, visibility, refreshKey = 0 } = opts
  const scopedOrgId = orgId != null && Number.isInteger(orgId) && orgId > 0 ? orgId : null
  const debouncedQuery = useDebouncedValue(query, TEAM_DIRECTORY_SEARCH_DEBOUNCE_MS)
  const fetchKey = `${enabled}:${jwt}:${scopedOrgId}:${debouncedQuery}:${visibility}:${refreshKey}`
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const nextCursorRef = useRef<string | null>(null)
  const loadingMoreRef = useRef(false)
  nextCursorRef.current = nextCursor
  const needsFetch = Boolean(enabled && jwt && scopedOrgId != null)
  const loading = needsFetch && settledKey !== fetchKey

  useLayoutEffect(() => {
    if (!enabled || !jwt || scopedOrgId == null) {
      setTeams([])
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
        const page = await listTeamsPage(jwt, scopedOrgId, {
          q: debouncedQuery,
          limit: TEAM_DIRECTORY_PAGE_SIZE,
          visibility,
          signal: controller.signal,
        })
        if (requestIdRef.current !== requestId) return
        setTeams(page.groups)
        setNextCursor(page.nextCursor)
        setSettledKey(fetchKey)
      } catch (e) {
        if (controller.signal.aborted) return
        if (requestIdRef.current !== requestId) return
        setTeams([])
        setNextCursor(null)
        setError(e instanceof Error ? e.message : String(e))
        setSettledKey(fetchKey)
      }
    })()

    return () => {
      controller.abort()
    }
  }, [enabled, jwt, scopedOrgId, debouncedQuery, visibility, refreshKey, fetchKey])

  const loadMore = useCallback(() => {
    if (!enabled || !jwt || scopedOrgId == null) return
    const cursor = nextCursorRef.current
    if (!cursor || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const requestId = requestIdRef.current
    void (async () => {
      try {
        const page = await listTeamsPage(jwt, scopedOrgId, {
          q: debouncedQuery,
          limit: TEAM_DIRECTORY_PAGE_SIZE,
          cursor,
          visibility,
        })
        if (requestIdRef.current !== requestId) return
        setTeams((prev) => mergeTeams(prev, page.groups))
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
  }, [enabled, jwt, scopedOrgId, debouncedQuery, visibility])

  return {
    teams,
    loading,
    searching: needsFetch && (query !== debouncedQuery || loading),
    loadingMore,
    error,
    hasMore: nextCursor != null,
    loadMore,
  }
}

function mergeTeams(prev: TeamSummary[], incoming: TeamSummary[]): TeamSummary[] {
  if (incoming.length === 0) return prev
  const seen = new Set(prev.map((t) => t.id))
  const extra = incoming.filter((t) => !seen.has(t.id))
  return extra.length === 0 ? prev : [...prev, ...extra]
}
