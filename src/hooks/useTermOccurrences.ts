// AQU-1192: occurrences of one concept, from the sync-worker projection.
//
// Thin client: useState + a race-guarded effect. Opening a term must not
// download every file's cells. Pages append; a concept change replaces them.

import { useCallback, useEffect, useRef, useState } from "react"
import type { CellData } from "@/hooks/useCells"
import { fetchConceptOccurrences, occurrenceToCell } from "@/lib/sync/concept-occurrences-read"
import type { TermFormTally } from "@/lib/terminology/occurrence-page"

const PAGE_SIZE = 100

export interface UseTermOccurrencesOpts {
  projectId: string | null
  conceptId: string | null
  getToken?: (fileId: string) => Promise<string | null>
  enabled?: boolean
  /** Legacy tag of the lane whose renderings judge the target. `''` is the former default lane. */
  lane?: string
}

export interface UseTermOccurrences {
  cells: CellData[]
  total: number
  enforced: number
  infringed: number
  /** Surfaces counted across the whole scan, not just the loaded page. */
  forms: TermFormTally[]
  /** False when the server stopped before the end of the project. */
  scanComplete: boolean
  isLoading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  revalidate: () => void
  applyOptimisticTargetEdit: (
    cell: { cellId: string; fileId: string },
    patch: { value: string; valueHtml?: string },
  ) => void
}

const EMPTY: CellData[] = []

export function useTermOccurrences(opts: UseTermOccurrencesOpts): UseTermOccurrences {
  const { projectId, conceptId, getToken, enabled = true, lane } = opts
  const [cells, setCells] = useState<CellData[]>(EMPTY)
  const [total, setTotal] = useState(0)
  const [enforced, setEnforced] = useState(0)
  const [infringed, setInfringed] = useState(0)
  const [forms, setForms] = useState<TermFormTally[]>([])
  const [scanComplete, setScanComplete] = useState(true)
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [pending, setPending] = useState<ReadonlyMap<string, { value: string; valueHtml?: string }>>(new Map())

  const tokenRef = useRef(getToken)
  useEffect(() => {
    tokenRef.current = getToken
  }, [getToken])

  const requestRef = useRef(0)
  useEffect(() => {
    const seq = ++requestRef.current
    const current = () => requestRef.current === seq
    if (!enabled || !projectId || !conceptId) {
      setCells(EMPTY)
      setPending(new Map())
      setTotal(0)
      setEnforced(0)
      setInfringed(0)
      setForms([])
      setScanComplete(true)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const controller = new AbortController()
    void (async () => {
      try {
        const token = tokenRef.current ? await tokenRef.current("any") : null
        if (!token) {
          if (!current()) return
          setCells(EMPTY)
          setError("no sync token for project")
          setLoading(false)
          return
        }
        const pages = await Promise.all(
          Array.from({ length: pageCount }, (_, index) =>
            fetchConceptOccurrences(projectId, conceptId, token, {
              offset: index * PAGE_SIZE,
              limit: PAGE_SIZE,
              signal: controller.signal,
              lane,
            }),
          ),
        )
        if (!current()) return
        const last = pages[pages.length - 1]
        const next = pages.flatMap((page) => page.occurrences.map(occurrenceToCell))
        setCells(next)
        setPending((prev) => {
          if (prev.size === 0) return prev
          const kept = new Map(prev)
          for (const row of next) {
            const shadow = kept.get(`${row.fileId}\0${row.id}`)
            if (shadow && shadow.value === row.translated) kept.delete(`${row.fileId}\0${row.id}`)
          }
          return kept.size === prev.size ? prev : kept
        })
        setTotal(last?.total ?? 0)
        setEnforced(last?.enforced ?? 0)
        setInfringed(last?.infringed ?? 0)
        setForms(last?.forms ?? [])
        setScanComplete(last?.scanComplete ?? true)
        setError(null)
      } catch (err) {
        if (!current() || (err instanceof DOMException && err.name === "AbortError")) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (current()) setLoading(false)
      }
    })()
    return () => {
      controller.abort()
    }
  }, [projectId, conceptId, enabled, pageCount, reloadNonce, lane])

  useEffect(() => {
    setPageCount(1)
    setPending(new Map())
  }, [projectId, conceptId])

  const loadMore = useCallback(() => {
    setPageCount((count) => count + 1)
  }, [])

  const revalidate = useCallback(() => {
    setReloadNonce((n) => n + 1)
  }, [])

  const applyOptimisticTargetEdit = useCallback(
    (cell: { cellId: string; fileId: string }, patch: { value: string; valueHtml?: string }) => {
      setPending((prev) => {
        const next = new Map(prev)
        next.set(`${cell.fileId}\0${cell.cellId}`, patch)
        return next
      })
    },
    [],
  )

  const visibleCells = pending.size === 0
    ? cells
    : cells.map((row) => {
        const shadow = pending.get(`${row.fileId}\0${row.id}`)
        if (!shadow) return row
        return {
          ...row,
          translated: shadow.value,
          ...(shadow.valueHtml !== undefined ? { translatedHtml: shadow.valueHtml } : {}),
          status: shadow.value.trim() ? "unvalidated" as const : "empty" as const,
        }
      })

  const hasMore = scanComplete && cells.length < total
  return {
    cells: visibleCells,
    total,
    enforced,
    infringed,
    forms,
    scanComplete,
    isLoading,
    error,
    hasMore,
    loadMore,
    revalidate,
    applyOptimisticTargetEdit,
  }
}
