// Phase 2b: aligned with the Phase 2a fetch pattern (vanilla useState +
// race-guarded effect; no React Query). Same upstream endpoint
// (`/cells/audit-stats?fileId=`) — the migration is purely about pattern
// consistency.
//
// `useCompositeHealth` consumes this hook's Map as a useEffect dep, so we
// preserve a stable empty-map reference between renders to avoid resetting
// its debounce on every keystroke.

import { useCallback, useEffect, useRef, useState } from "react"
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
}

const EMPTY_AUDIT_STATS = new Map<string, CellAuditStats>()

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
  const body = (await res.json()) as { cells: Partial<CellAuditStats>[] }
  const map = new Map<string, CellAuditStats>()
  for (const row of body.cells) {
    if (!row.cellId) continue
    map.set(row.cellId, {
      cellId: row.cellId,
      editCount: row.editCount ?? 0,
      contentHash: row.contentHash ?? "",
      lastEditAt: row.lastEditAt ?? null,
      lastEditEventId: row.lastEditEventId ?? null,
      activeValidators: row.activeValidators ?? [],
    })
  }
  return map
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

  return { byCellId: data, isLoading, isError, revalidate }
}
