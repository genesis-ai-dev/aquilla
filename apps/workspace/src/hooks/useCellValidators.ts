// Phase 2b: aligned with the Phase 2a fetch pattern (vanilla useState +
// race-guarded effect; no React Query). Reads the existing
// `/cell-validators` endpoint exposed by the sync-worker; that route is
// file-scoped, but identity mints sync-tokens per file so the file
// scope is satisfied implicitly.

import { useCallback, useEffect, useRef, useState } from "react"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

export interface CellValidator {
  editEventId: string
  username: string
  isActive: boolean
  decidedTs: number
}

export interface UseCellValidatorsOptions {
  enabled: boolean
  fileId: string | null
  cellId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
}

export interface UseCellValidatorsResult {
  validators: CellValidator[]
  isLoading: boolean
  isError: boolean
  revalidate: () => void
}

async function fetchCellValidators(
  fileId: string,
  cellId: string,
  jwt: string,
): Promise<CellValidator[]> {
  const url = new URL(`${syncWorkerHttpOrigin()}/cell-validators`)
  url.searchParams.set("fileId", fileId)
  url.searchParams.set("cellId", cellId)
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`cell-validators failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const body = (await res.json()) as { validators: CellValidator[] }
  // Server returns by decided_ts DESC; pass through as-is.
  return body.validators
}

export function useCellValidators(opts: UseCellValidatorsOptions): UseCellValidatorsResult {
  const { enabled, fileId, cellId, getTokenForFile } = opts

  const [validators, setValidators] = useState<CellValidator[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const fileRef = useRef(fileId)
  const cellRef = useRef(cellId)
  const tokenRef = useRef(getTokenForFile)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  fileRef.current = fileId
  cellRef.current = cellId
  tokenRef.current = getTokenForFile
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const fid = fileRef.current
    const cid = cellRef.current
    if (!enabledRef.current || !fid || !cid) {
      setValidators([])
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
      const rows = await fetchCellValidators(fid, cid, token)
      if (generationRef.current !== gen) return
      setValidators(rows)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellValidators] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, cellId, enabled])

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

  return { validators, isLoading, isError, revalidate }
}
