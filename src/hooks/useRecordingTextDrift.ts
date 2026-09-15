// AQU-464 — resolve a cell's takes against its text history.
//
// One history read per cell answers the question for every take on it, so the
// takes strip asks once and looks each take up in the returned map. Follows the
// AD-3 read-hook pattern (plain useState + race-guarded effect, no React
// Query) and re-reads on the same invalidation signals as the history drawer,
// so committing new text re-flags the takes recorded against the old text
// without a reload.

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchCellHistory } from "@/lib/sync/history-read"
import { subscribeToCellHistoryInvalidation } from "@/lib/sync/history-invalidation"
import {
  resolveRecordingTextDriftMap,
  type RecordingTextDrift,
} from "@/lib/audio/text-drift"

export interface UseRecordingTextDriftOptions {
  enabled: boolean
  projectId: string | null
  fileId: string | null
  cellId: string | null
  /** Takes to resolve. Order is irrelevant; identity is the audioId. */
  audioIds: readonly string[]
  getTokenForFile: (projectId: string, fileId: string) => Promise<string | null>
  /** AD-2 chain head, when the caller knows it. See `ResolveDriftOptions`. */
  currentEventId?: string | null
}

const EMPTY: ReadonlyMap<string, RecordingTextDrift> = new Map()

/**
 * Drift per take, keyed by audioId.
 *
 * A take absent from the map is one we could not place — never assume "no
 * drift" from a miss. The map is empty until the read lands, so the badge
 * appears rather than flickers away.
 */
export function useRecordingTextDrift(
  opts: UseRecordingTextDriftOptions,
): ReadonlyMap<string, RecordingTextDrift> {
  const { enabled, projectId, fileId, cellId, audioIds, getTokenForFile, currentEventId } = opts

  const [drift, setDrift] = useState<ReadonlyMap<string, RecordingTextDrift>>(EMPTY)

  // A stable key over the take set: the effect must re-run when a take is
  // added or removed, but not on every render that rebuilds the same array.
  const audioKey = [...audioIds].sort().join("|")

  // Inputs the effects must read WITHOUT re-subscribing on: the take list is
  // already keyed by `audioKey`, and callers commonly pass a freshly-built
  // token fetcher every render. Refreshed in an effect declared before the
  // ones that read it, so a render's values are in place by the time they run.
  const latest = useRef({ audioIds, getTokenForFile, currentEventId: currentEventId ?? null })
  const generationRef = useRef(0)

  useEffect(() => {
    latest.current = { audioIds, getTokenForFile, currentEventId: currentEventId ?? null }
  })

  const doFetch = useCallback(async () => {
    const { audioIds: ids, getTokenForFile: getToken, currentEventId: head } = latest.current
    if (!enabled || !projectId || !fileId || !cellId || ids.length === 0) {
      setDrift(EMPTY)
      return
    }
    const gen = ++generationRef.current
    try {
      const token = await getToken(projectId, fileId)
      if (!token || generationRef.current !== gen) return
      const events = await fetchCellHistory(projectId, fileId, cellId, token, { limit: 200 })
      if (generationRef.current !== gen) return
      setDrift(resolveRecordingTextDriftMap(events, ids, { currentEventId: head }))
    } catch (err) {
      if (generationRef.current !== gen) return
      // Non-fatal: drift is an advisory badge, and a strip that cannot reach
      // history should still play, rename and delete takes.
      console.warn("[useRecordingTextDrift] history read failed:", err)
    }
  }, [enabled, projectId, fileId, cellId])

  useEffect(() => {
    void doFetch()
  }, [doFetch, audioKey])

  // New text on this cell changes every take's answer — re-resolve on the same
  // signal the history drawer listens to.
  useEffect(() => {
    if (!enabled || !projectId || !fileId || !cellId) return
    let timer: number | null = null
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void doFetch()
      }, 75)
    }
    const unsubscribe = subscribeToCellHistoryInvalidation(projectId, fileId, cellId, schedule)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [doFetch, enabled, projectId, fileId, cellId])

  return drift
}
