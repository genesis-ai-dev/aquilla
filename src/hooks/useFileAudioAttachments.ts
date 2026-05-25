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

  const [byCellId, setByCellId] = useState<Map<string, CellAudioEntry>>(EMPTY)
  const [isLoading, setIsLoading] = useState(false)
  const generationRef = useRef(0)

  const doFetch = useCallback(async () => {
    if (!projectId || !fileId) {
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
      if (gen === generationRef.current) setByCellId(EMPTY)
    } finally {
      if (gen === generationRef.current) setIsLoading(false)
    }
  }, [projectId, fileId, getToken])

  useEffect(() => {
    void doFetch()
  }, [doFetch])

  useEffect(() => {
    if (!fileId) return
    return subscribeAudioAttachments(fileId, () => {
      void doFetch()
    })
  }, [fileId, doFetch])

  return { byCellId, isLoading, revalidate: doFetch }
}
