// Phase 2b: cell edit history (legacy CellHistoryEntry projection).
//
// Overlap with useCellHistory: both fetch the same event log via the
// sync-worker, but this hook returns the narrower legacy shape consumed
// by HistoryDrawer (one entry per `*.cell.commit` event, mapped to
// `{timestamp, value, source, author, validated}`). useCellHistory exposes
// the raw event chain for callers that need parent pointers / payloads /
// non-commit kinds. Phase 2c collapses both into one when the audit + drawer
// surfaces have aligned.
//
// Compared to the pre-Phase 2b implementation:
//   - dropped @tanstack/react-query dependency in favor of the Phase 2a
//     pattern (vanilla useState + race-guarded effect)
//   - now goes through `fetchCellHistory` (server returns AD-2-prefixed
//     kinds; we filter to `*.cell.commit` to preserve the old drawer's
//     "value history only" view)

import { useCallback, useEffect, useRef, useState } from "react"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { fetchCellHistory } from "@/lib/sync/history-read"
import type { CellHistoryEvent } from "@/lib/sync/history-read-types"
import {
  getOutboxRecordsForCell,
  subscribeToOutbox,
  type OutboxRecord,
} from "@/lib/sync/outbox"
import { subscribeToCellHistoryInvalidation } from "@/lib/sync/history-invalidation"

export interface UseCellEditHistoryOptions {
  enabled: boolean
  /** Project the cell belongs to. New in Phase 2b: server reads need the
   *  projectId for the sync-token / DB scope. Callers wire this from the
   *  active project. */
  projectId: string | null
  fileId: string | null
  cellId: string | null
  /** Server clamps to [1, 200]; default 50. */
  limit?: number
  getTokenForFile: (fileId: string) => Promise<string | null>
  /**
   * AD-2 chain head for this cell (the projection's current `event_id`).
   * Used to mark stale-sibling commits in the returned history. When omitted
   * the drawer falls back to "everything is current" rendering — safer than
   * mis-flagging winning commits as stale.
   */
  currentEventId?: string | null
}

export interface UseCellEditHistoryResult {
  history: CellHistoryEntry[]
  isLoading: boolean
  isError: boolean
  revalidate: () => void
}

/**
 * Build the set of event ids that are currently on the AD-2 chain — the
 * sequence reachable by walking back from the cell's chain head (current
 * `cells.event_id`) via `parentId` pointers. Any commit not in this set is
 * a stale sibling that lost its first-child-of-parent race; it stays in the
 * log so the user can find it from the history drawer, but it never
 * advanced the projection.
 *
 * If `currentEventId` is absent (no projection yet, or caller didn't pass
 * one) we treat the whole list as on-chain — falling back to the pre-AD-2
 * "everything is current" rendering, which is better than mis-flagging
 * winning commits as stale.
 */
function computeOnChainSet(
  events: CellHistoryEvent[],
  currentEventId: string | null,
): Set<string> | null {
  if (!currentEventId) return null
  const byId = new Map<string, CellHistoryEvent>()
  for (const e of events) byId.set(e.id, e)
  // If the supplied head doesn't appear in the events we just read, the
  // caller passed a head for a different side of the cell (eg. target head
  // while we're viewing source history) or for a chain that's outside the
  // limit window. Fall back to null — flagging every commit stale would be
  // strictly worse than not flagging at all.
  if (!byId.has(currentEventId)) return null
  const onChain = new Set<string>()
  let cursor: string | null = currentEventId
  // Guard against runaway walks if the data ever cycles. A cell's chain
  // should never exceed the events we just read, so events.length is a
  // safe upper bound.
  let steps = events.length + 1
  while (cursor && steps-- > 0) {
    if (onChain.has(cursor)) break
    onChain.add(cursor)
    const node = byId.get(cursor)
    if (!node) break
    cursor = node.parentId
  }
  return onChain
}

function mapEventsToEntries(
  events: CellHistoryEvent[],
  currentEventId: string | null,
): CellHistoryEntry[] {
  // Walk events chronologically. Each commit becomes a history entry; each
  // validate/unvalidate flips the `validated` flag on the entry whose
  // editEventId it references. Server returns newest-first, so we reverse.
  // The on-chain set decides whether each commit is the current chain
  // lineage or a stale branch — the drawer renders stale entries with a
  // distinct visual treatment so the user can find their bumped edit.
  const onChain = computeOnChainSet(events, currentEventId)
  const entries: CellHistoryEntry[] = []
  const indexByCommitId = new Map<string, number>()
  for (const e of [...events].reverse()) {
    if (e.kind === "target.cell.commit" || e.kind === "source.cell.commit") {
      const payload = e.payload as { value?: string } | null
      const idx = entries.length
      entries.push({
        timestamp: new Date(e.serverTs).toISOString(),
        value: payload?.value ?? "",
        source: "human",
        author: e.author,
        validated: false,
        eventId: e.id,
        // `onChain === null` means we couldn't compute (no head id passed) —
        // treat everything as on-chain rather than risk false stale flags.
        isStale: onChain ? !onChain.has(e.id) : false,
      })
      indexByCommitId.set(e.id, idx)
    } else if (e.kind === "cell.validate" || e.kind === "cell.unvalidate") {
      const payload = e.payload as { editEventId?: string } | null
      const targetId = payload?.editEventId
      if (!targetId) continue
      const idx = indexByCommitId.get(targetId)
      if (idx === undefined) continue
      entries[idx] = { ...entries[idx], validated: e.kind === "cell.validate" }
    }
  }
  return entries
}

function mapOutboxToEntries(records: OutboxRecord[]): CellHistoryEntry[] {
  const entries: CellHistoryEntry[] = []
  for (const record of records) {
    const event = record.event
    if (event.kind !== "target.cell.commit" && event.kind !== "source.cell.commit") continue
    const payload = event.payload as { value?: string; ai_suggestion?: true }
    entries.push({
      timestamp: new Date(event.clientTs || record.enqueuedAt).toISOString(),
      value: payload.value ?? "",
      source: payload.ai_suggestion ? "llm" : "human",
      author: event.author,
      validated: false,
      eventId: event.id,
      isStale: false,
      syncState: record.status === "failed" ? "failed" : "pending",
    })
  }
  return entries
}

function mergeHistoryEntries(
  serverEntries: CellHistoryEntry[],
  localEntries: CellHistoryEntry[],
): CellHistoryEntry[] {
  const serverIds = new Set(serverEntries.flatMap((entry) => entry.eventId ? [entry.eventId] : []))
  return [
    ...serverEntries,
    ...localEntries.filter((entry) => !entry.eventId || !serverIds.has(entry.eventId)),
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

export function useCellEditHistory(opts: UseCellEditHistoryOptions): UseCellEditHistoryResult {
  const { enabled, projectId, fileId, cellId, limit, getTokenForFile, currentEventId } = opts

  const [history, setHistory] = useState<CellHistoryEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const cellRef = useRef(cellId)
  const limitRef = useRef(limit)
  const tokenFetcherRef = useRef(getTokenForFile)
  const enabledRef = useRef(enabled)
  const headRef = useRef(currentEventId ?? null)
  const generationRef = useRef(0)

  projectRef.current = projectId
  fileRef.current = fileId
  cellRef.current = cellId
  limitRef.current = limit
  tokenFetcherRef.current = getTokenForFile
  enabledRef.current = enabled
  headRef.current = currentEventId ?? null

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const fid = fileRef.current
    const cid = cellRef.current
    if (!enabledRef.current || !pid || !fid || !cid) {
      setHistory([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      // IndexedDB is the local durability point. Show those commits even when
      // auth, network, or server projection is temporarily unavailable.
      const localEntries = mapOutboxToEntries(
        await getOutboxRecordsForCell(pid, fid, cid),
      )
      if (generationRef.current !== gen) return
      setHistory(localEntries)

      const token = await tokenFetcherRef.current(fid)
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const rows = await fetchCellHistory(pid, fid, cid, token, { limit: limitRef.current })
      if (generationRef.current !== gen) return
      setHistory(mergeHistoryEntries(
        mapEventsToEntries(rows, headRef.current),
        localEntries,
      ))
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellEditHistory] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, cellId, enabled, limit])

  // Refresh from durable local changes and exact server event.applied frames.
  // Both sources share one timer, coalescing an outbox write + its WS echo.
  // Browser focus/visibility is deliberately not an invalidation source: it
  // caused duplicate, visibly slow reads every time the user switched apps.
  useEffect(() => {
    if (!enabledRef.current || !projectId || !fileId || !cellId) return
    let timer: number | null = null
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void doFetch()
      }, 75)
    }
    const unsubscribeOutbox = subscribeToOutbox(schedule)
    const unsubscribeServer = subscribeToCellHistoryInvalidation(
      projectId,
      fileId,
      cellId,
      schedule,
    )
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsubscribeOutbox()
      unsubscribeServer()
    }
  }, [doFetch, enabled, projectId, fileId, cellId])

  const revalidate = useCallback(() => {
    void doFetch()
  }, [doFetch])

  return { history, isLoading, isError, revalidate }
}
