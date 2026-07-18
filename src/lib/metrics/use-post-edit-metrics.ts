/**
 * usePostEditMetrics — derive post-edit magnitude from the event log.
 *
 * DATA FLOW
 * ---------
 * For each file in the project:
 *   1. Mint a sync-token scoped to that file.
 *   2. Fetch all target.cell.commit events for the file via the existing
 *      GET /events?fileId=... endpoint (paginated, up to MAX_EVENTS per file).
 *   3. Group events by cellId.
 *   4. Run extractPostEditPairs on each cell's chain.
 *   5. Aggregate all pairs into weekly buckets + per-user summary.
 *
 * LIMITATIONS / APPROXIMATIONS
 * - Fetches up to MAX_EVENTS events per file (default 200, server max).
 *   Files with very long edit histories may be truncated. A SWARM-TODO marks
 *   this for a future server-side aggregation route.
 * - Only works for cloud-synced projects (projectId must be a server-side UUID).
 *   Local-only projects return empty metrics.
 * - Runs sequentially per file to avoid token-mint stampedes on large projects.
 *
 * SWARM-TODO(fro-311-server-route): replace per-file client fetch with a
 *   dedicated GET /api/v1/projects/:projectId/post-edit-metrics route that
 *   computes aggregations on the server with a single SQL query over the
 *   events table. The client-side approach here is sufficient for the first
 *   version with projects of ≤10 files and ≤200 events each.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { makeSyncTokenFetcher } from "@/lib/sync/sync-token"
import {
  extractPostEditPairs,
  aggregatePostEditMetrics,
  type CommitEvent,
  type PostEditMetrics,
} from "./post-edit-metrics"

const MAX_EVENTS_PER_FILE = 200

interface RawEventRow {
  id: string
  kind: string
  fileId: string | null
  cellId: string | null
  parentId: string | null
  author: string
  payload: unknown
  clientTs: number
  serverTs: number
  serverSeq: number
}

async function fetchFileCommitEvents(
  fileId: string,
  token: string,
): Promise<CommitEvent[]> {
  const url =
    `${syncWorkerHttpOrigin()}/events?fileId=${encodeURIComponent(fileId)}` +
    `&limit=${MAX_EVENTS_PER_FILE}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return []
  const body = (await res.json()) as { events: RawEventRow[] }
  // Keep target commits plus the approval events that make a draft measurable.
  return body.events
    .filter(
      (e) =>
        (e.kind === "target.cell.commit" || e.kind === "target.cell.create" || e.kind === "cell.validate") &&
        e.cellId !== null,
    )
    .map((e) => ({
      id: e.id,
      parentId: e.parentId,
      kind: e.kind,
      author: e.author,
      serverTs: e.serverTs,
      serverSeq: e.serverSeq,
      payload: e.payload,
      cellId: e.cellId ?? undefined,
    }))
}

export interface UsePostEditMetricsOptions {
  /** Server-side project UUID. null → skip fetching. */
  projectId: string | null
  /** File list for the project. */
  files: { id: string; name: string }[]
  /** JWT accessor for minting sync-tokens. */
  getJwt: () => string | null
  /** Pass false to defer fetch. */
  enabled?: boolean
}

export interface UsePostEditMetricsResult {
  metrics: PostEditMetrics | null
  isLoading: boolean
  isError: boolean
  /** Call to re-fetch (e.g. after the user clicks "Refresh"). */
  revalidate: () => void
}

export function usePostEditMetrics({
  projectId,
  files,
  getJwt,
  enabled = true,
}: UsePostEditMetricsOptions): UsePostEditMetricsResult {
  const [metrics, setMetrics] = useState<PostEditMetrics | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const generationRef = useRef(0)
  const projectIdRef = useRef(projectId)
  const filesRef = useRef(files)
  const getJwtRef = useRef(getJwt)
  const enabledRef = useRef(enabled)

  projectIdRef.current = projectId
  filesRef.current = files
  getJwtRef.current = getJwt
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const pid = projectIdRef.current
    const fileList = filesRef.current
    if (!enabledRef.current || !pid || fileList.length === 0) {
      setMetrics(null)
      setIsLoading(false)
      setIsError(false)
      return
    }

    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)

    try {
      const allPairs: ReturnType<typeof extractPostEditPairs> = []

      for (const file of fileList) {
        if (generationRef.current !== gen) return
        // Mint a per-file sync token.
        const fetcher = makeSyncTokenFetcher(
          () => getJwtRef.current(),
          pid,
          file.id,
        )
        const token = await fetcher()
        if (!token) continue

        const events = await fetchFileCommitEvents(file.id, token)
        if (generationRef.current !== gen) return

        // Group by cellId.
        const byCellId = new Map<string, CommitEvent[]>()
        for (const ev of events) {
          const key = ev.cellId ?? ""
          if (!key) continue
          const arr = byCellId.get(key) ?? []
          arr.push(ev)
          byCellId.set(key, arr)
        }

        for (const [cellId, cellEvents] of byCellId) {
          const pairs = extractPostEditPairs(cellEvents, cellId, file.id)
          allPairs.push(...pairs)
        }
      }

      if (generationRef.current !== gen) return
      setMetrics(aggregatePostEditMetrics(allPairs))
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[usePostEditMetrics] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, files.map((f) => f.id).join(","), enabled])

  const revalidate = useCallback(() => void doFetch(), [doFetch])

  return { metrics, isLoading, isError, revalidate }
}
