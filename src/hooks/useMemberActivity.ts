// AQU-498: per-member activity read hook — recent actions + files-worked-on
// rollup for a single project member, straight off the sync-worker event log.
//
// Same race-guarded fetch-on-mount / revalidate() pattern as useCellHistory
// (AD-3 thin-client reads: plain useState + useEffect, no React Query/SWR).

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchMemberActivity } from "@/lib/sync/member-activity-read"
import type { MemberActivityEvent, MemberFileRollup } from "@/lib/sync/member-activity-read-types"

export interface UseMemberActivityOptions {
  projectId: string | null
  /** The member's Aquilla username (events.author), not a numeric user id. */
  author: string | null
  /** Server clamps to [1, 200]; default 50. */
  limit?: number
  getToken?: () => Promise<string | null>
  /** Disable the fetch (e.g. no member selected yet). */
  enabled?: boolean
}

export interface UseMemberActivityResult {
  events: MemberActivityEvent[]
  fileRollup: MemberFileRollup[]
  revalidate: () => void
  isLoading: boolean
  isError: boolean
}

export function useMemberActivity(opts: UseMemberActivityOptions): UseMemberActivityResult {
  const { projectId, author, limit, getToken, enabled = true } = opts

  const [events, setEvents] = useState<MemberActivityEvent[]>([])
  const [fileRollup, setFileRollup] = useState<MemberFileRollup[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const authorRef = useRef(author)
  const limitRef = useRef(limit)
  const tokenFetcherRef = useRef(getToken)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  projectRef.current = projectId
  authorRef.current = author
  limitRef.current = limit
  tokenFetcherRef.current = getToken
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const auth = authorRef.current
    if (!enabledRef.current || !pid || !auth) {
      setEvents([])
      setFileRollup([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const fetchToken = tokenFetcherRef.current
      const token = fetchToken ? await fetchToken() : null
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const result = await fetchMemberActivity(pid, auth, token, { limit: limitRef.current })
      if (generationRef.current !== gen) return
      setEvents(result.recentEvents)
      setFileRollup(result.fileRollup)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useMemberActivity] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, author, enabled, limit])

  const revalidate = useCallback(() => {
    void doFetch()
  }, [doFetch])

  return { events, fileRollup, revalidate, isLoading, isError }
}
