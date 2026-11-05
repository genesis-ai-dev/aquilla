// The hand-set milestones of one file, read live. (AQU-2308)
//
// DORMANT ON ARRIVAL. The whole pipeline below this hook ships complete and
// tested — the two events, their floors, the projection, the table and this
// read — but nothing mounts the hook yet: the cell-menu entry and the
// Set-a-new-milestone dialog are the follow-on slice. The derivation already
// takes `userMilestones` and is covered end to end
// (`milestone-navigation.userMilestones.test.ts`), so that slice is a UI
// change rather than a migration. Same staging `file.track.set` shipped under,
// and for the same reason.
//
// Shaped on useFileCellLinks: plain `useState` + a race-guarded `useEffect`
// (AD-3 — never `useQuery`/`useMutation`), plus a small optimistic overlay.
//
// THE OVERLAY IS NOT A CACHE, IT IS THE PENDING EDIT. Saving a milestone has
// to put the row in the navigator immediately, and the event behind it can sit
// in the outbox for a while (the flusher backs off; background tabs throttle
// timers). So a local record outranks the server's answer until the server
// SAYS THE SAME THING, at which point the override is dropped rather than
// expiring on a clock — the lesson SUB-48 taught the attachments hook, that a
// wall clock is the wrong lifetime for "has my edit landed yet".

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useFrontierSession } from "@/hooks/useFrontierSession"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import {
  fetchFileMilestones,
  type FileMilestoneRow,
} from "@/lib/sync/file-milestones-read"
import type { FileMilestone } from "../../db/shared/file-milestones"

export interface UseFileMilestonesArgs {
  projectId: string | null
  fileId: string | null
}

export interface UseFileMilestonesResult {
  /** Stored records with the overlay applied, in the server's stable order. */
  milestones: readonly FileMilestone[]
  isLoading: boolean
  /** True once this file's milestones have an answer: the first read came back
   *  (or failed), or there is nothing to read. A refresh never turns it false. */
  hasLoaded: boolean
  error?: Error
  /** Paint a saved milestone immediately, before its event is accepted. */
  setMilestoneLocally(milestone: FileMilestone): void
  /** Paint a removal immediately. */
  removeMilestoneLocally(milestoneId: string): void
  refresh(): void
}

/** `undefined` in the overlay means "this id is being removed". */
type Override = FileMilestone | undefined

const EMPTY: readonly FileMilestone[] = []

function sameMilestone(a: FileMilestone, b: FileMilestone): boolean {
  return a.name === b.name
    && a.startCellId === b.startCellId
    && a.endCellId === b.endCellId
}

export function useFileMilestones({
  projectId,
  fileId,
}: UseFileMilestonesArgs): UseFileMilestonesResult {
  const [rows, setRows] = useState<readonly FileMilestoneRow[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | undefined>()
  /** milestone id → the record this device is waiting for the server to echo. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map())
  const [refreshKey, setRefreshKey] = useState(0)
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const generationRef = useRef(0)

  const { session, loading: sessionLoading } = useFrontierSession()
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  const getToken = useMemo(() => makeAudioSyncTokenFetcher(() => sessionRef.current), [])
  // The cold-reload trap: the JWT is not ready on first render and `getToken`
  // is stable, so without watching the token the first fetch bails and nothing
  // ever retries.
  const jwt = session?.jwt ?? null
  const readKey = projectId && fileId ? `${projectId}/${fileId}` : null
  const hasLoaded = readKey === null || (!jwt && !sessionLoading) || settledKey === readKey

  useEffect(() => {
    const gen = ++generationRef.current
    if (!projectId || !fileId || !jwt) {
      setRows([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    let cancelled = false
    void (async () => {
      const token = await getToken(projectId, fileId)
      if (!token) throw new Error("Couldn't get a read token for this file's milestones.")
      return await fetchFileMilestones(projectId, fileId, token)
    })()
      .then((res) => {
        if (cancelled || gen !== generationRef.current) return
        setRows(res.milestones)
        setError(undefined)
        setIsLoading(false)
        setSettledKey(`${projectId}/${fileId}`)
        // Retire every override the server now agrees with. Anything still
        // disagreeing is an edit that has not landed yet and stays painted.
        setOverrides((prev) => {
          if (prev.size === 0) return prev
          const live = new Map(res.milestones.map((row) => [row.id, row]))
          let changed = false
          const next = new Map(prev)
          for (const [id, wanted] of prev) {
            const server = live.get(id)
            const agreed = wanted === undefined
              ? server === undefined
              : server !== undefined && sameMilestone(server, wanted)
            if (agreed) {
              next.delete(id)
              changed = true
            }
          }
          return changed ? next : prev
        })
      })
      .catch((cause: unknown) => {
        if (cancelled || gen !== generationRef.current) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setIsLoading(false)
        setSettledKey(`${projectId}/${fileId}`)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, fileId, jwt, getToken, refreshKey])

  const setMilestoneLocally = useCallback((milestone: FileMilestone) => {
    setOverrides((prev) => new Map(prev).set(milestone.id, milestone))
  }, [])

  const removeMilestoneLocally = useCallback((milestoneId: string) => {
    setOverrides((prev) => new Map(prev).set(milestoneId, undefined))
  }, [])

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  const milestones = useMemo<readonly FileMilestone[]>(() => {
    if (overrides.size === 0) {
      return rows.length === 0 ? EMPTY : rows.map(toRecord)
    }
    const merged: FileMilestone[] = []
    for (const row of rows) {
      if (overrides.has(row.id)) continue
      merged.push(toRecord(row))
    }
    for (const [, wanted] of overrides) {
      if (wanted !== undefined) merged.push(wanted)
    }
    // Same order the route returns, so the navigator does not reshuffle when
    // an override retires.
    merged.sort((a, b) => (
      a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    ))
    return merged
  }, [rows, overrides])

  return {
    milestones,
    isLoading,
    hasLoaded,
    error,
    setMilestoneLocally,
    removeMilestoneLocally,
    refresh,
  }
}

function toRecord(row: FileMilestoneRow): FileMilestone {
  return {
    id: row.id,
    name: row.name,
    startCellId: row.startCellId,
    endCellId: row.endCellId,
  }
}
