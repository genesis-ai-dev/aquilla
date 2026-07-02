// Phase 2b: aligned with the Phase 2a fetch pattern (vanilla useState +
// race-guarded effect; no React Query). Same upstream endpoint
// (`/cells/audit-stats?fileId=`) — the migration is purely about pattern
// consistency.
//
// `useCompositeHealth` consumes this hook's Map as a useEffect dep, so we
// preserve a stable empty-map reference between renders to avoid resetting
// its debounce on every keystroke.

import { useCallback, useEffect, useRef, useState } from "react"
import type { RuleWaiver } from "@/lib/parsers/types"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

export interface CellAuditStats {
  cellId: string
  editCount: number
  contentHash: string
  /** Server clock at the cell's most recent commit. null when the cell hasn't been
   *  projected from a CQRS event yet (e.g. legacy Y.Doc-only seeded rows). */
  lastEditAt: number | null
  /** UUIDv7 of the cell.commit event that produced the current value. Carry this
   *  on validate/unvalidate events so the validator binds to the right edit. */
  lastEditEventId: string | null
  /** Active validators tied to lastEditEventId. Empty when the current edit has
   *  no approvals or when lastEditEventId is null. */
  activeValidators: string[]
  /** Active QA rule waivers on this cell (one per dismissed rule). Empty when
   *  no rule is currently waived. */
  waivers: RuleWaiver[]
}

interface UseCellsAuditStatsOptions {
  enabled: boolean
  fileId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
}

export interface UseCellsAuditStatsResult {
  byCellId: Map<string, CellAuditStats>
  isLoading: boolean
  isError: boolean
  revalidate: () => void
  /** Targeted refetch for a single cell (e.g. right after that cell's
   *  commit/validate/waive), merged into the existing map. Avoids
   *  re-fetching the whole file's stats on every single-cell commit. */
  revalidateCellStats: (cellId: string) => void
}

const EMPTY_AUDIT_STATS = new Map<string, CellAuditStats>()

type CellAuditStatsWireRow = Partial<CellAuditStats> & { side?: string }

function toCellAuditStats(row: CellAuditStatsWireRow): CellAuditStats | null {
  if (!row.cellId) return null
  return {
    cellId: row.cellId,
    editCount: row.editCount ?? 0,
    contentHash: row.contentHash ?? "",
    lastEditAt: row.lastEditAt ?? null,
    lastEditEventId: row.lastEditEventId ?? null,
    activeValidators: row.activeValidators ?? [],
    waivers: row.waivers ?? [],
  }
}

function mergeStatsRows(rows: CellAuditStatsWireRow[]): Map<string, CellAuditStats> {
  const map = new Map<string, CellAuditStats>()
  const sides = new Map<string, string | undefined>()
  for (const row of rows) {
    const stats = toCellAuditStats(row)
    if (!stats) continue
    const existingSide = sides.get(stats.cellId)
    if (!map.has(stats.cellId) || (existingSide !== "target" && row.side === "target")) {
      map.set(stats.cellId, stats)
      sides.set(stats.cellId, row.side)
    }
  }
  return map
}

async function fetchCellsAuditStats(
  fileId: string,
  jwt: string,
): Promise<Map<string, CellAuditStats>> {
  const url = `${syncWorkerHttpOrigin()}/cells/audit-stats?fileId=${encodeURIComponent(fileId)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`cells/audit-stats failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const body = (await res.json()) as { cells: CellAuditStatsWireRow[] }
  return mergeStatsRows(body.cells)
}

// Single-cell variant of fetchCellsAuditStats — same endpoint, scoped via
// the optional `cellId` query param (see cells-audit-read-route.ts).
async function fetchCellAuditStats(
  fileId: string,
  cellId: string,
  jwt: string,
): Promise<CellAuditStats | null> {
  const url = `${syncWorkerHttpOrigin()}/cells/audit-stats?fileId=${encodeURIComponent(fileId)}&cellId=${encodeURIComponent(cellId)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`cells/audit-stats (cell) failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const body = (await res.json()) as { cells: CellAuditStatsWireRow[] }
  return mergeStatsRows(body.cells).get(cellId) ?? null
}

export function useCellsAuditStats(opts: UseCellsAuditStatsOptions): UseCellsAuditStatsResult {
  const { enabled, fileId, getTokenForFile } = opts

  const [data, setData] = useState<Map<string, CellAuditStats>>(EMPTY_AUDIT_STATS)
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const fileRef = useRef(fileId)
  const tokenRef = useRef(getTokenForFile)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  fileRef.current = fileId
  tokenRef.current = getTokenForFile
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const fid = fileRef.current
    if (!enabledRef.current || !fid) {
      setData(EMPTY_AUDIT_STATS)
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const token = await tokenRef.current(fid)
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const map = await fetchCellsAuditStats(fid, token)
      if (generationRef.current !== gen) return
      setData(map)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellsAuditStats] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, enabled])

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

  const revalidate = useCallback(() => {
    void doFetch()
  }, [doFetch])

  const revalidateCellStats = useCallback((cellId: string) => {
    const fid = fileRef.current
    if (!enabledRef.current || !fid) return
    void (async () => {
      try {
        const token = await tokenRef.current(fid)
        if (!token) return
        const stats = await fetchCellAuditStats(fid, cellId, token)
        // The active file may have changed while this was in flight — don't
        // merge stale-file data into the current map.
        if (!stats || fileRef.current !== fid) return
        setData((prev) => {
          const next = new Map(prev)
          next.set(stats.cellId, stats)
          return next
        })
      } catch (err) {
        console.warn("[useCellsAuditStats] cell revalidate failed:", err)
      }
    })()
  }, [])

  return { byCellId: data, isLoading, isError, revalidate, revalidateCellStats }
}
