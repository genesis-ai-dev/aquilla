// The React side of `lib/audio/transport.ts`: subscribe to both engines and
// hand back one answer. (AQU-646 round 5)
//
// Kept out of the selector module so the rule stays testable without mocking
// three stores, and out of `play-queue.ts` so the queue does not have to know
// the video exists.

import { useMemo } from "react"
import { useQueueForFile } from "@/lib/audio/play-queue"
import {
  selectTransportForFile,
  videoOwnsFile,
  type TransportForFile,
} from "@/lib/audio/transport"
import {
  useVideoBuffering,
  useVideoClockPlaying,
  useVideoClockSec,
  useVideoRate,
  useVideoSoundingCellId,
  useVideoVolume,
} from "@/lib/timeline/video-clock"
import { useVideoDurationSec } from "@/lib/timeline/video-duration"

export interface UseTransportForFileArgs {
  /** This file's cell ids — the queue's scope guard, unchanged. */
  cellIds: ReadonlySet<string>
  /** The linked picture, if any. */
  coreMediaUrl: string | null | undefined
  /** True when ANY cell's clock is file time (i.e. an imported recording is the
   *  master). Callers pass `cells.some(queueClockIsFileTime)` — the same test
   *  the pane and Space already use. */
  anyCellClockIsFileTime: boolean
  /** Whether the video pane is actually mounted. The pane registers the
   *  controller, so without it there is nothing to drive — see `videoOwnsFile`. */
  paneOnScreen: boolean
}

/**
 * Who is playing this file, and what is it doing.
 *
 * Hooks are called unconditionally (the video stores are cheap module
 * subscriptions), and the choice is made in the pure selector — so this cannot
 * violate the rules of hooks when a file gains or loses its linked video.
 */
export function useTransportForFile({
  cellIds,
  coreMediaUrl,
  anyCellClockIsFileTime,
  paneOnScreen,
}: UseTransportForFileArgs): TransportForFile {
  const queue = useQueueForFile(cellIds)
  const currentSec = useVideoClockSec()
  const playing = useVideoClockPlaying()
  const soundingCellId = useVideoSoundingCellId()
  const durationSec = useVideoDurationSec(coreMediaUrl ?? null)
  const rate = useVideoRate()
  const volume = useVideoVolume()
  const buffering = useVideoBuffering()
  const ownedByVideo = videoOwnsFile(coreMediaUrl, anyCellClockIsFileTime, paneOnScreen)

  return useMemo(
    () =>
      selectTransportForFile(
        queue,
        ownedByVideo
          ? { currentSec, playing, durationSec, soundingCellId, rate, volume, buffering }
          : null,
      ),
    [queue, ownedByVideo, currentSec, playing, durationSec, soundingCellId, rate, volume, buffering],
  )
}
