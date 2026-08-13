/**
 * Read an audio-cue sibling's cues for the timeline's Source-audio track.
 * (AQU-646 stage 2)
 *
 * Deliberately NOT the cells-cache / live-sync machinery every editable file
 * goes through. These cues are frozen: they are a transcript of a finished
 * film, no event ever mutates them, and nobody but this one timeline row reads
 * them. There is no delta to track, so a single read of the whole file — ~550
 * rows, one page — is the entire lifecycle. Subscribing them to live sync would
 * buy nothing and put 550 immutable rows into the cache's budget.
 *
 * A replace mints a NEW sibling file id, so the id change alone re-runs the
 * fetch; there is no invalidation to arrange.
 */

import { useEffect, useRef, useState } from "react"

import { buildCellData, type CellData } from "@/hooks/useCells"
import { fetchAllFileCells } from "@/lib/sync/cells-read"

export interface UseAudioCueCellsArgs {
  projectId: string | null
  /** The hidden sibling's file id, or null when this file has no audio cues. */
  siblingFileId: string | null
  getToken: (fileId: string) => Promise<string | null>
}

export interface UseAudioCueCellsResult {
  /**
   * null and [] mean different things and the timeline depends on the
   * difference: null = there is no sibling, so the Source-audio track does not
   * exist at all; [] = the sibling exists and its cues are still loading (or
   * it genuinely holds none), so the track is there and empty.
   */
  audioCues: CellData[] | null
  isLoading: boolean
  error?: Error
}

export function useAudioCueCells({
  projectId,
  siblingFileId,
  getToken,
}: UseAudioCueCellsArgs): UseAudioCueCellsResult {
  const [audioCues, setAudioCues] = useState<CellData[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | undefined>()
  const generationRef = useRef(0)

  // The caller builds `getToken` inline, so its identity changes on every
  // render. Hold it in a ref and key the effect on the ids alone — in the deps
  // it would restart the read continuously, each publication re-rendering the
  // workspace into a fresh callback.
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  useEffect(() => {
    const generation = ++generationRef.current
    if (!projectId || !siblingFileId) {
      setAudioCues(null)
      setIsLoading(false)
      setError(undefined)
      return
    }

    setAudioCues([])
    setIsLoading(true)
    setError(undefined)

    let cancelled = false
    void (async () => {
      const token = await getTokenRef.current(siblingFileId)
      if (!token) throw new Error("Couldn't get a read token for this file's audio cues.")
      // Source side only: a cue row has no target, and asking for both would
      // just make the response wider.
      return await fetchAllFileCells(projectId, siblingFileId, token, "source")
    })()
      .then((rows) => {
        if (cancelled || generation !== generationRef.current) return
        setAudioCues(
          rows.map((row) =>
            buildCellData(row.cellId, row, undefined, siblingFileId, "local", 1, undefined),
          ),
        )
        setIsLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled || generation !== generationRef.current) return
        // Keep the empty array rather than dropping back to null: the track
        // exists — the file is there — it just has nothing to draw.
        setAudioCues([])
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, siblingFileId])

  return { audioCues, isLoading, error }
}
