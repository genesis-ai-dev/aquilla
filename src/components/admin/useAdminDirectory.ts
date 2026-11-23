import { useEffect, useRef, useState } from "react"
import type { SortingState } from "@tanstack/react-table"
import type { AdminListPage, AdminListQuery } from "@/lib/frontier/admin"

export const ADMIN_DIRECTORY_PAGE_SIZE = 50

/**
 * One page of an admin directory. Search is debounced, and a new search, sort,
 * or query (a lens, an org) starts again at the first page. `load` is read
 * from a ref so an inline caller does not refetch on every render.
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
  /** Changes (lens, org, starting sort) reset the page and the sort. */
  queryKey: string
  initialSort: { id: string; desc: boolean }
  debounceMs?: number
  pageSize?: number
}) {
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [page, setPage] = useState(0)
  const [sorting, setSortingState] = useState<SortingState>([initialSort])
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [overdue, setOverdue] = useState<number | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const [seenKey, setSeenKey] = useState(queryKey)
  if (seenKey !== queryKey) {
    setSeenKey(queryKey)
    setSortingState([initialSort])
    setPage(0)
  }

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search.trim()), debounceMs)
    return () => clearTimeout(handle)
  }, [search, debounceMs])

  const [seenSearch, setSeenSearch] = useState(debounced)
  if (seenSearch !== debounced) {
    setSeenSearch(debounced)
    setPage(0)
  }

  const sort = sorting[0] ?? initialSort
  const requestKey = `${enabled}:${queryKey}:${debounced}:${page}:${sort.id}:${sort.desc}:${pageSize}`
  const [seenRequest, setSeenRequest] = useState(requestKey)
  if (enabled && seenRequest !== requestKey) {
    setSeenRequest(requestKey)
    setLoading(true)
    setSearching(debounced !== "")
    setError(null)
  }

  useEffect(() => {
    if (!enabled) return
    let alive = true
    void loadRef
      .current({
        q: debounced || undefined,
        limit: pageSize,
        offset: page * pageSize,
        sort: sort.id,
        dir: sort.desc ? "desc" : "asc",
      })
      .then((result) => {
        if (!alive) return
        setRows(result.rows)
        setTotal(result.total)
        setOverdue(result.overdue)
        setLoading(false)
        setSearching(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
        setSearching(false)
      })
    return () => {
      alive = false
    }
  }, [enabled, queryKey, debounced, page, sort.id, sort.desc, pageSize])

  function setSorting(next: SortingState) {
    setSortingState(next.length > 0 ? next : [initialSort])
    setPage(0)
  }

  return {
    rows,
    total,
    overdue,
    loading,
    searching,
    error,
    search,
    setSearch,
    page,
    setPage,
    sorting,
    setSorting,
    pageSize,
  }
}
