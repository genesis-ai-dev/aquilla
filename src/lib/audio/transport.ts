// WHICH ENGINE IS PLAYING THIS FILE. (AQU-646 round 5)
//
// Aquilla has two things that can be playing: the play QUEUE (the audio engine
// every file type uses) and, for a subtitle file timed against footage, the
// linked VIDEO itself. Until now every consumer read the queue directly, so on
// a video-first file the bottom bar reported "paused / 0:00" while the picture
// ran, the dialogue table never scrolled, and pressing the bar's play button
// started the queue on a lone recorded take with no film behind it.
//
// None of that was a race or a bug in either engine. Each surface was simply
// wired to one of two transports, arbitrarily. This module is the one place
// that answers "who owns this file, and what is it doing" — so a consumer can
// no longer be wired to the wrong half.
//
// The shape is deliberately `QueueForFile`'s, because the video maps onto it
// 1:1 and every existing consumer already speaks it. Adding a source tag is
// enough to tell them apart where it matters (which controller to command).
//
// The pure selector lives apart from the hook for the same reason
// `queue-scope.ts` splits them: a test can exercise the real rule without
// mocking three stores.

import type { QueueForFile } from "./queue-scope"

export type TransportSource = "queue" | "video"

export interface TransportForFile extends QueueForFile {
  /** Which engine these numbers came from. `"video"` only ever for a file whose
   *  linked picture is the transport — see `videoOwnsFile`. */
  source: TransportSource
}

/** The video's side of the story, as the stores already publish it. */
export interface VideoTransportInput {
  /** `video-clock.ts`; null when the picture is not driving. */
  currentSec: number | null
  playing: boolean
  /** `video-duration.ts`, keyed by URL. 0/undefined until metadata lands. */
  durationSec: number | null | undefined
  /** `cellIdAtSec`, published by the pane. Null in a silence. */
  soundingCellId: string | null
  /** The element's own rate/volume, mirrored from `ratechange`/`volumechange`
   *  so the bar and the picture's native controls always show the same number. */
  rate: number
  volume: number
}

/**
 * Does the PICTURE own this file?
 *
 * The same test the video pane uses to decide it is standalone, and the same
 * one Space is routed by — written once here so a fourth copy cannot drift.
 * A file has a linked video and no cell whose clock is file time (i.e. no
 * imported source recording); in that arrangement the queue can still be made
 * to run, but its clock is a per-take clock starting at 0 and it means nothing
 * against the film.
 */
export function videoOwnsFile(
  coreMediaUrl: string | null | undefined,
  anyCellClockIsFileTime: boolean,
): boolean {
  return Boolean(coreMediaUrl) && !anyCellClockIsFileTime
}

/**
 * Fold the two engines into one answer.
 *
 * The queue WINS whenever it is genuinely running this file's cells, even on a
 * video-owned file — that is today's precedence in the video pane's caption
 * (`queue.cellId != null` beats the standalone cell unconditionally) and
 * changing it here would make the two disagree.
 */
export function selectTransportForFile(
  queue: QueueForFile,
  video: VideoTransportInput | null,
): TransportForFile {
  if (!video || queue.active) return { ...queue, source: "queue" }
  const active = video.currentSec != null
  const duration = video.durationSec != null && Number.isFinite(video.durationSec) ? video.durationSec : 0
  return {
    active,
    playing: active && video.playing,
    // The video has no cold-load dip to protect: `running` and `playing` are
    // the same thing for a picture that is already streaming.
    running: active && video.playing,
    cellId: active ? video.soundingCellId : null,
    kind: active ? (video.playing ? "playing" : "paused") : "idle",
    // A picture reports its own failures through the pane's error card; the
    // bar never has an error of its own to show for the video.
    errorMessage: null,
    progress: {
      currentTime: video.currentSec ?? 0,
      duration,
      // The PICTURE's rate and volume, never the queue's — showing an idle
      // queue's 1.5x would be a readout about a transport that is not sounding.
      rate: video.rate,
      volume: video.volume,
    },
    source: "video",
  }
}
