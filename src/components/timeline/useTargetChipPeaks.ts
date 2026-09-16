// Peaks for the take chips currently on screen. (AQU-646)
//
// Modelled on useClipAudioMissing next door — same async-with-cancellation
// discipline, same reason for keying the effect on `jwt`/`username` rather than
// the `session` object, whose identity churns every render.
//
// WHY THIS LIVES IN THE LANE AND NOT THE EDITOR. It needs the set of chips that
// are both VISIBLE and DRAWABLE, and only the lane knows that — it resolves
// each chip's geometry and applies the visibility window in its own chips loop.
// Computing it in the editor would mean duplicating that loop over every item
// in the file on every scroll tick, and creating a second place that has to
// agree about which clips have a measured duration. Reaching back up with an
// onVisibleChanged callback would be a render loop.
//
// Peaks are decoded once per clip per session and then kept: a Float32Array of
// 320 bins is 1.3KB, so a whole episode's worth is a rounding error next to the
// audio it came from, and re-decoding on every scroll-back would not be.

import { useEffect, useRef, useState } from "react"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { loadPeaksBatch, type PeaksTarget } from "@/lib/audio/peaks-loader"
import type { FrontierSession } from "@/lib/frontier/types"

export interface UseTargetChipPeaksArgs {
  /** Visible, drawable chips only — a clip with no measured duration has no
   *  honest mapping from bins to seconds and must not be fetched at all. */
  targets: readonly PeaksTarget[]
  projectId: string | null
  /** The FILE being viewed, used only to scope the cache; each target carries
   *  its own owning fileId, which is what the fetch actually uses. */
  fileId: string | null
  session: FrontierSession | null
  bins: number
}

export function useTargetChipPeaks({
  targets,
  projectId,
  fileId,
  session,
  bins,
}: UseTargetChipPeaksArgs): ReadonlyMap<string, Float32Array> {
  const byKey = useRef(new Map<string, Float32Array>())
  const [, bumpVersion] = useState(0)

  const jwt = session?.jwt ?? null
  const username = session?.username ?? null

  // Everything a clip needs, flattened to a string. The effect must not re-run
  // because the lane rebuilt an equal array — which it does on every render,
  // and therefore on every scroll tick.
  const wanted = targets
    .filter((t) => !byKey.current.has(t.attachmentKey))
    .map((t) => t.attachmentKey)
    .join("|")

  // A file switch invalidates every peak we hold: the map is keyed by
  // attachment id, and painting one file's waveform onto another file's chip is
  // exactly the bug the cancellation below exists to prevent.
  useEffect(() => {
    byKey.current = new Map()
    bumpVersion((v) => v + 1)
  }, [fileId])

  useEffect(() => {
    if (!wanted || !projectId || !jwt) return
    const missing = targets.filter((t) => !byKey.current.has(t.attachmentKey))
    if (missing.length === 0) return

    let cancelled = false
    let pending = false
    // One re-render per frame however many clips land in it: a 189-take file
    // resolving from a warm cache would otherwise re-render the lane 189 times.
    const flush = () => {
      if (pending || cancelled) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        if (!cancelled) bumpVersion((v) => v + 1)
      })
    }

    void loadPeaksBatch({
      targets: missing,
      projectId,
      bins,
      getSyncToken: audioSyncTokenFetcherForSession(session),
      isCancelled: () => cancelled,
      onLoaded: (attachmentKey, peaks) => {
        byKey.current.set(attachmentKey, peaks)
        flush()
      },
    })

    return () => {
      cancelled = true
    }
    // `targets` is excluded on purpose: it is a fresh array every render, and
    // `wanted` is the string that actually says whether anything new is needed.
    // `session` likewise — jwt/username are the fields the token fetcher keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, projectId, jwt, username, bins])

  return byKey.current
}
