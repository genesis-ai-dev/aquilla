// AQU-1192: violations for the open project, from the sync-worker scan.
// Opening the tab must not download every file's cells.

import { useEffect, useRef, useState } from "react"
import { fetchTerminologyViolations } from "@/lib/sync/terminology-scan-read"
import type { TerminologyViolationRow } from "@/lib/terminology/project-scan"

export interface UseTerminologyViolationsOpts {
  projectId: string | null
  getToken?: (fileId: string) => Promise<string | null>
  enabled?: boolean
  /** Legacy tag of the lane to scan. `''` is the former default lane. */
  lane?: string
}

export interface UseTerminologyViolations {
  rows: TerminologyViolationRow[]
  isLoading: boolean
  error: string | null
  scanComplete: boolean
  truncated: boolean
}

const EMPTY: TerminologyViolationRow[] = []

export function useTerminologyViolations(opts: UseTerminologyViolationsOpts): UseTerminologyViolations {
  const { projectId, getToken, enabled = true, lane } = opts
  const [rows, setRows] = useState<TerminologyViolationRow[]>(EMPTY)
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanComplete, setScanComplete] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const tokenRef = useRef(getToken)
  useEffect(() => {
    tokenRef.current = getToken
  }, [getToken])

  const requestRef = useRef(0)
  useEffect(() => {
    const seq = ++requestRef.current
    const current = () => requestRef.current === seq
    if (!enabled || !projectId) {
      setRows(EMPTY)
      setError(null)
      setLoading(false)
      setScanComplete(true)
      setTruncated(false)
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
          setRows(EMPTY)
          setError("no sync token for project")
          setLoading(false)
          return
        }
        const page = await fetchTerminologyViolations(projectId, token, {
          signal: controller.signal,
          lane,
        })
        if (!current()) return
        setRows(page.violations)
        setScanComplete(page.scanComplete)
        setTruncated(page.truncated)
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
  }, [projectId, enabled, lane])

  return { rows, isLoading, error, scanComplete, truncated }
}
