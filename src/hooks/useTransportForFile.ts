// The React side of `lib/audio/transport.ts`: subscribe to both engines and
// hand back one answer. (AQU-646 round 5)
//
// Kept out of the selector module so the rule stays testable without mocking
// three stores, and out of `play-queue.ts` so the queue does not have to know
// the video exists.

import { useMemo, useSyncExternalStore } from "react"
import { useQueueForFile, useQueueStateForFile } from "@/lib/audio/play-queue"
import {
  selectTransportForFile,
  videoOwnsFile,
  virtualOwnsFile,
  type TransportForFile,
  type TransportSource,
} from "@/lib/audio/transport"
import {
  getVideoClockSec,
  subscribeVideoClock,
  useVideoBuffering,
  useVideoClockActive,
  useVideoClockPlaying,
  useVideoClockSec,
  useVideoRate,
  useVideoSoundingCellId,
  useVideoVolume,
} from "@/lib/timeline/video-clock"
import { useVideoDurationSec } from "@/lib/timeline/video-duration"
import { recordingDrivesPlayback, type PlaybackSource } from "@/lib/audio/playback-source"
import { heldCellIdAtSec, type RegionSegment } from "@/lib/timeline/source-regions"
import {
  getVirtualClockSec,
  subscribeVirtualClock,
  useVirtualClockActive,
  useVirtualClockPlaying,
  useVirtualClockRate,
  useVirtualClockSec,
  useVirtualClockVolume,
} from "@/lib/timeline/virtual-clock"

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
  /**
   * AQU-646 stage 3h: the end of the last cue, for a file that has timings and
   * no master. 0 or absent means there is no timeline to run a playhead along,
   * which is every arrangement this does not apply to.
   */
  timelineDurationSec?: number
  /** The line the playhead is on, over the cells that actually hold takes. */
  virtualSoundingCellId?: string | null
  /**
   * AQU-1565 follow-up: which sound the person chose for this file. With
   * `"video"`, a recording does not take the transport off a picture that is
   * on screen. Absent reads as `"recording"`, which is the old rule exactly.
   */
  playbackSource?: PlaybackSource
  /** AQU-1704: Free timing is the queue's, never the virtual clock's. See `virtualOwnsFile`. */
  freeTiming?: boolean
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
  timelineDurationSec = 0,
  virtualSoundingCellId = null,
  playbackSource = "recording",
  freeTiming = false,
}: UseTransportForFileArgs): TransportForFile {
  const queue = useQueueForFile(cellIds)
  const currentSec = useVideoClockSec()
  const playing = useVideoClockPlaying()
  const soundingCellId = useVideoSoundingCellId()
  const durationSec = useVideoDurationSec(coreMediaUrl ?? null)
  const rate = useVideoRate()
  const volume = useVideoVolume()
  const buffering = useVideoBuffering()
  const ownedByVideo = videoOwnsFile(
    coreMediaUrl,
    recordingDrivesPlayback(anyCellClockIsFileTime, playbackSource),
    paneOnScreen,
  )
  // Unconditional, like the video's — these are cheap module subscriptions, and
  // the CHOICE is made in the pure selector, so a file gaining or losing its
  // picture can never change the number of hooks called.
  const virtualSec = useVirtualClockSec()
  const virtualPlaying = useVirtualClockPlaying()
  const virtualRate = useVirtualClockRate()
  const virtualVolume = useVirtualClockVolume()
  // Reads `ownedByVideo`, not `coreMediaUrl`: a film whose pane is off screen
  // has nothing to drive, so the virtual clock is correct there.
  //
  // The RAW recording test on purpose, not the chosen source: with the pane
  // off screen and "the video's own sound" chosen there is still a real
  // recording to play, and the queue is the right player for it. A silent
  // virtual playhead would not be.
  const ownedByVirtual = virtualOwnsFile(ownedByVideo, anyCellClockIsFileTime, timelineDurationSec, freeTiming)

  return useMemo(
    () =>
      selectTransportForFile(
        queue,
        ownedByVideo
          ? { currentSec, playing, durationSec, soundingCellId, rate, volume, buffering }
          : null,
        ownedByVirtual
          ? {
              currentSec: virtualSec,
              playing: virtualPlaying,
              durationSec: timelineDurationSec,
              soundingCellId: virtualSoundingCellId,
              rate: virtualRate,
              volume: virtualVolume,
            }
          : null,
      ),
    [
      queue, ownedByVideo, currentSec, playing, durationSec, soundingCellId, rate, volume, buffering,
      ownedByVirtual, virtualSec, virtualPlaying, virtualRate, virtualVolume, timelineDurationSec,
      virtualSoundingCellId,
    ],
  )
}

export type TransportStateForFile = Omit<TransportForFile, "progress">

const NO_PROGRESS = { currentTime: 0, duration: 0, rate: 1, volume: 1, programmeClock: false }

/**
 * `useTransportForFile` without the clock, for a consumer that draws no time.
 * The clocks publish 4–20×/sec while playing, and a workspace that read them
 * re-rendered the whole timeline on each one. Only whether each engine is
 * driving reaches the selector here, which is all its state depends on.
 */
export function useTransportStateForFile({
  cellIds,
  coreMediaUrl,
  anyCellClockIsFileTime,
  paneOnScreen,
  timelineDurationSec = 0,
  virtualSoundingCellId = null,
  playbackSource = "recording",
  freeTiming = false,
}: UseTransportForFileArgs): TransportStateForFile {
  const queue = useQueueStateForFile(cellIds)
  const videoActive = useVideoClockActive()
  const playing = useVideoClockPlaying()
  const soundingCellId = useVideoSoundingCellId()
  const buffering = useVideoBuffering()
  const ownedByVideo = videoOwnsFile(
    coreMediaUrl,
    recordingDrivesPlayback(anyCellClockIsFileTime, playbackSource),
    paneOnScreen,
  )
  const virtualActive = useVirtualClockActive()
  const virtualPlaying = useVirtualClockPlaying()
  const ownedByVirtual = virtualOwnsFile(ownedByVideo, anyCellClockIsFileTime, timelineDurationSec, freeTiming)

  return useMemo(() => {
    const { progress: _progress, ...state } = selectTransportForFile(
      { ...queue, progress: NO_PROGRESS },
      ownedByVideo
        ? { currentSec: videoActive ? 0 : null, playing, durationSec: 0, soundingCellId, rate: 1, volume: 1, buffering }
        : null,
      ownedByVirtual
        ? {
            currentSec: virtualActive ? 0 : null,
            playing: virtualPlaying,
            durationSec: 0,
            soundingCellId: virtualSoundingCellId,
            rate: 1,
            volume: 1,
          }
        : null,
    )
    return state
  }, [
    queue, ownedByVideo, videoActive, playing, soundingCellId, buffering,
    ownedByVirtual, virtualActive, virtualPlaying, virtualSoundingCellId,
  ])
}

const clockOf: Partial<Record<TransportSource, { subscribe: (l: () => void) => () => void; sec: () => number | null }>> = {
  video: { subscribe: subscribeVideoClock, sec: getVideoClockSec },
  virtual: { subscribe: subscribeVirtualClock, sec: getVirtualClockSec },
}
const NO_CLOCK = { subscribe: () => () => {}, sec: () => null }

/**
 * The line under a picture's or virtual clock's head, held through the
 * silence after it (`heldCellIdAtSec`). Re-renders when the LINE changes, not
 * on every tick. Null for the queue, which always names its own line while it
 * runs.
 */
export function useHeldCellIdOnClock(
  source: TransportSource,
  enabled: boolean,
  segments: readonly RegionSegment[],
): string | null {
  const clock = (enabled ? clockOf[source] : undefined) ?? NO_CLOCK
  const read = () => {
    const sec = clock.sec()
    return sec == null ? null : heldCellIdAtSec(segments, sec)
  }
  return useSyncExternalStore(clock.subscribe, read, read)
}
