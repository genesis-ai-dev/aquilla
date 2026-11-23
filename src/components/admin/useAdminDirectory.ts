import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { SortingState } from "@tanstack/react-table"
import type { AdminListPage, AdminListQuery } from "@/lib/frontier/admin"

export const ADMIN_DIRECTORY_PAGE_SIZE = 50

/**
 * Admin directory that grows as the table scrolls, the same way the project
 * and team directories do. Search and sort start again from the first page.
 * `load` is read from a ref so an inline caller does not refetch every render.
 */
export function useAdminDirectory<T>({
  enabled = true,
  load,
  queryKey,
  initialSort,
  debounceMs = 200,
  pageSize = ADMIN_DIRECTORY_PAGE_SIZE,
}: {
  enabled?: boolean
  load: (query: AdminListQuery) => Promise<AdminListPage<T>>
  /** Changes (lens, org, starting sort) reset the list and the sort. */
  queryKey: string
  initialSort: { id: string; desc: boolean }
  debounceMs?: number
  pageSize?: number
}) {
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [sorting, setSortingState] = useState<SortingState>([initialSort])
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [overdue, setOverdue] = useState<number | null>(null)
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const [seenKey, setSeenKey] = useState(queryKey)
  if (seenKey !== queryKey) {
    setSeenKey(queryKey)
    setSortingState([initialSort])
  }

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search.trim()), debounceMs)
    return () => clearTimeout(handle)
  }, [search, debounceMs])

  const sort = sorting[0] ?? initialSort
  const fetchKey = `${enabled}:${queryKey}:${debounced}:${sort.id}:${sort.desc}:${pageSize}`
  const [seenFetch, setSeenFetch] = useState(fetchKey)
  if (seenFetch !== fetchKey) {
    setSeenFetch(fetchKey)
    setExhausted(false)
  }

  const requestIdRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const rowsRef = useRef(rows)
  const totalRef = useRef(total)
  const loading = enabled && settledKey !== fetchKey

  useEffect(() => {
    rowsRef.current = rows
    totalRef.current = total
  })

  useLayoutEffect(() => {
    if (!enabled) return
    const requestId = ++requestIdRef.current
    loadingMoreRef.current = false
    let alive = true
    void loadRef
      .current({
        q: debounced || undefined,
        limit: pageSize,
        offset: 0,
        sort: sort.id,
        dir: sort.desc ? "desc" : "asc",
      })
      .then((result) => {
        if (!alive || requestIdRef.current !== requestId) return
        setRows(result.rows)
        setTotal(result.total)
        setOverdue(result.overdue)
        setExhausted(result.rows.length === 0 || result.rows.length >= result.total)
        setError(null)
        setLoadingMore(false)
        setSettledKey(fetchKey)
      })
      .catch((err: unknown) => {
        if (!alive || requestIdRef.current !== requestId) return
        setRows([])
        setTotal(0)
        setOverdue(null)
        setExhausted(true)
        setError(err instanceof Error ? err.message : String(err))
        setLoadingMore(false)
        setSettledKey(fetchKey)
      })
    return () => {
      alive = false
    }
  }, [enabled, fetchKey, debounced, pageSize, sort.id, sort.desc])

  const loadMore = useCallback(() => {
    if (!enabled || loadingMoreRef.current) return
    const loaded = rowsRef.current.length
    if (loaded === 0 || loaded >= totalRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const requestId = requestIdRef.current
    void loadRef
      .current({
        q: debounced || undefined,
        limit: pageSize,
        offset: loaded,
        sort: sort.id,
        dir: sort.desc ? "desc" : "asc",
      })
      .then((result) => {
        if (requestIdRef.current !== requestId) return
        setRows((prev) => (result.rows.length === 0 ? prev : [...prev, ...result.rows]))
        setTotal(result.total)
        setOverdue(result.overdue)
        if (result.rows.length === 0 || loaded + result.rows.length >= result.total) {
          setExhausted(true)
        }
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [enabled, debounced, pageSize, sort.id, sort.desc])

  function setSorting(next: SortingState) {
    setSortingState(next.length > 0 ? next : [initialSort])
  }

  const hasMore = !exhausted && rows.length < total

  return {
    rows,
    total,
    overdue,
    loading,
    loadingMore,
    searching: enabled && (search.trim() !== debounced || loading),
    error,
    search,
    setSearch,
    sorting,
    setSorting,
    pageSize,
    hasMore,
    loadMore,
  }
}
