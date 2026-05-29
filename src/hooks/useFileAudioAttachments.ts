// Per-file cell-audio attachments read. Vanilla useState + race-guarded
// effect (no React Query), matching useCellValidators. Subscribes to the
// audio-attachments bus so a local emit (recording / TTS / clone) refetches
// without prop-drilling a revalidate callback.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import { subscribeAudioAttachments } from "@/lib/audio/audio-attachments-bus"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

export interface UseFileAudioAttachmentsResult {
  byCellId: Map<string, CellAudioEntry>
  isLoading: boolean
  revalidate: () => void
}

const EMPTY: Map<string, CellAudioEntry> = new Map()

export function useFileAudioAttachments(
  projectId: string | null,
  fileId: string | null,
): UseFileAudioAttachmentsResult {
  const { session } = useFrontierSession()
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  const getToken = useMemo(
    () => makeAudioSyncTokenFetcher(() => sessionRef.current),
    [],
  )
  // On a cold reload the session JWT isn't ready on first render, so the
  // initial fetch bails with no token and — because getToken is stable — never
  // retries on its own. Track the JWT so the fetch re-runs the moment auth
  // lands. (Symptom without this: zero `audio-attachments` requests on reload;
  // audio only appears after a generate pokes the bus.)
  const jwt = session?.jwt ?? null

  const [byCellId, setByCellId] = useState<Map<string, CellAudioEntry>>(EMPTY)
  const [isLoading, setIsLoading] = useState(false)
  const generationRef = useRef(0)

  const doFetch = useCallback(async () => {
    // No project/file, or auth not ready yet → nothing to read. Gating on `jwt`
    // here (rather than only inside getToken) makes it a real dependency, so the
    // fetch re-runs the moment the session lands on a cold reload.
    if (!projectId || !fileId || !jwt) {
      setByCellId(EMPTY)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    try {
      const token = await getToken(projectId, fileId)
      if (!token) {
        if (gen === generationRef.current) setByCellId(EMPTY)
        return
      }
      const res = await fetchFileAudioAttachments(projectId, fileId, token)
      if (gen !== generationRef.current) return // a newer fetch superseded us
      setByCellId(new Map(Object.entries(res.cells)))
    } catch {
      // Read failures degrade to "no attachments" — playback shows nothing
      // rather than the editor crashing. The next poke retries.
      if (gen === generationRef.current) setByCellId(EMPTY)
    } finally {
      if (gen === generationRef.current) setIsLoading(false)
    }
  }, [projectId, fileId, getToken, jwt])

  useEffect(() => {
    void doFetch()
  }, [doFetch])

  // Refetch when a producer pokes this file's bus channel.
  useEffect(() => {
    if (!fileId) return
    return subscribeAudioAttachments(fileId, () => {
      void doFetch()
    })
  }, [fileId, doFetch])

  return { byCellId, isLoading, revalidate: doFetch }
}
