// Proactively answers "is the selected timeline clip's stored audio gone?" so
// the detail pane can badge a missing recording BEFORE the user presses Play
// (the transport only learns it on playback). Mirrors the play-queue's
// recording-over-generated-voice preference and reuses the shared 404 probe.
//
// Timeline cells (from useCells) carry no audio attachments — those are read
// per-file by useFileAudioAttachments and merged in elsewhere. So we resolve
// the clip's take from that read's `CellAudioEntry`, not from the cell.

import { useEffect, useState } from "react"
import { parseFrontierAudioUrl, probeCellAudioPresent } from "@/lib/audio/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { audioCacheGet } from "@/lib/audio/bytes-cache"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"

export interface ClipAudio {
  audioId: string
  ext: string
}

/**
 * Resolve a cell's audio-attachment entry to its active take's (audioId, ext),
 * preferring a real recording over a generated voice — the same order the
 * play-queue plays them in, so the badge and playback agree on which take the
 * "missing" verdict is about. Returns null when there's no attachment or the
 * URL is a legacy (non-frontier) pointer we can't probe.
 */
export function resolveEntryAudio(entry: CellAudioEntry | undefined): ClipAudio | null {
  if (!entry) return null
  const id = entry.selectedAudioId ?? entry.selectedGeneratedVoiceAudioId
  if (!id) return null
  const att = entry.attachments[id]
  if (!att) return null
  return parseFrontierAudioUrl(att.url)
}

/**
 * True once the selected clip's stored audio is confirmed permanently gone
 * (404). A cached copy in OPFS short-circuits to "present" with no network
 * call. Only a definitive 404 flips this true — "unknown" (no token, network
 * blip, other status) stays false so a transient hiccup never flashes a
 * misleading badge. Race-guarded: switching clips before a probe resolves
 * discards the stale result.
 */
export function useClipAudioMissing(args: {
  audio: ClipAudio | null
  projectId: string | null
  fileId: string | null
  session: FrontierSession | null
}): boolean {
  const { audio, projectId, fileId, session } = args
  const [missing, setMissing] = useState(false)

  const audioId = audio?.audioId ?? null
  const ext = audio?.ext ?? null
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null

  useEffect(() => {
    if (!audioId || !ext || !projectId || !fileId || !jwt) {
      setMissing(false)
      return
    }
    let cancelled = false
    setMissing(false)
    void (async () => {
      // A locally-cached take is proof the object existed and is immutable —
      // never probe (and never badge) it.
      const cached = await audioCacheGet(audioId, ext)
      if (cancelled) return
      if (cached) return
      const presence = await probeCellAudioPresent({
        projectId,
        fileId,
        audioId,
        ext,
        getSyncToken: audioSyncTokenFetcherForSession(session),
      })
      if (!cancelled) setMissing(presence === "missing")
    })()
    return () => { cancelled = true }
    // `session` is intentionally excluded — its identity churns each render;
    // jwt/username capture the fields the token fetcher actually keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioId, ext, projectId, fileId, jwt, username])

  return missing
}
