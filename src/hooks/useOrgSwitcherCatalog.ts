import { useCallback, useEffect, useRef, useState } from "react"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { listOrgsPage, type OrgSummary } from "@/lib/frontier/orgs"

const PAGE_SIZE = 40

export const ORG_SWITCHER_SEARCH_DEBOUNCE_MS = 200

/**
 * Paged org-switcher catalog for platform operators. Memberships still live
 * in OrgContext; this hook only runs while the switcher is open and the
 * caller is a platform admin — everyone else keeps the in-memory membership
 * list and client-side filter.
 */
export function useOrgSwitcherCatalog(opts: {
  jwt: string | null
  open: boolean
  enabled: boolean
  query: string
}): {
  orgs: OrgSummary[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
} {
  const { jwt, open, enabled, query } = opts
  const debouncedQuery = useDebouncedValue(query, ORG_SWITCHER_SEARCH_DEBOUNCE_MS)
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const nextCursorRef = useRef<string | null>(null)
  const loadingMoreRef = useRef(false)
  nextCursorRef.current = nextCursor

  useEffect(() => {
    if (!open || !enabled || !jwt) {
      setOrgs([])
      setNextCursor(null)
      setError(null)
      setLoading(false)
      setLoadingMore(false)
      return
    }

    const controller = new AbortController()
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    setLoadingMore(false)
    loadingMoreRef.current = false

    void (async () => {
      try {
        const page = await listOrgsPage(jwt, {
          q: debouncedQuery,
          limit: PAGE_SIZE,
          signal: controller.signal,
        })
        if (requestIdRef.current !== requestId) return
        setOrgs(page.orgs)
        setNextCursor(page.nextCursor)
      } catch (e) {
        if (controller.signal.aborted) return
        if (requestIdRef.current !== requestId) return
        setOrgs([])
        setNextCursor(null)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    })()

    return () => {
      controller.abort()
    }
  }, [open, enabled, jwt, debouncedQuery])

  const loadMore = useCallback(() => {
    if (!open || !enabled || !jwt) return
    const cursor = nextCursorRef.current
    if (!cursor || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const requestId = requestIdRef.current
    void (async () => {
      try {
        const page = await listOrgsPage(jwt, {
          q: debouncedQuery,
          limit: PAGE_SIZE,
          cursor,
        })
        if (requestIdRef.current !== requestId) return
        setOrgs((prev) => mergeOrgs(prev, page.orgs))
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
  }, [open, enabled, jwt, debouncedQuery])

  return {
    orgs,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor != null,
    loadMore,
  }
}

function mergeOrgs(prev: OrgSummary[], incoming: OrgSummary[]): OrgSummary[] {
  if (incoming.length === 0) return prev
  const seen = new Set(prev.map((o) => o.id))
  const extra = incoming.filter((o) => !seen.has(o.id))
  return extra.length === 0 ? prev : [...prev, ...extra]
}
