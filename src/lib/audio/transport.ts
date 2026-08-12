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
  /** Round 6: asked to play, not able to yet — opening, or a seek still
   *  landing. The queue has always had this state; the picture reported only
   *  playing-or-paused, so a press during a slow seek looked like nothing
   *  happening at all. */
  buffering: boolean
}

/**
 * Does the PICTURE own this file's transport?
 *
 * Three things have to hold, and the third is the one that kept getting left
 * out. There must be a linked video; no cell may have a file-time clock (an
 * imported source recording, which makes the queue the master and slaves the
 * picture to it); and the PANE MUST BE ON SCREEN.
 *
 * That last one is not a detail about layout. The pane is what registers the
 * `VideoController`, so where it is hidden — Free timing, or a file that is not
 * time-ordered — there is nothing to drive. Round 5 taught this to Space and
 * to the dub driver but not to the playback bar, which went on claiming the
 * video transport in Free timing and then found no controller behind it: every
 * control on the bar dead, on a file whose queue could have played it.
 *
 * So this is now the single rule, and ProjectWorkspace's `videoIsTransport`
 * is this function. There is nowhere left for a copy to drift.
 */
export function videoOwnsFile(
  coreMediaUrl: string | null | undefined,
  anyCellClockIsFileTime: boolean,
  paneOnScreen: boolean,
): boolean {
  return Boolean(coreMediaUrl) && !anyCellClockIsFileTime && paneOnScreen
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
  // A picture that has been ASKED to play is the transport, even before it has
  // published a position. On a file just opened nothing has ticked or seeked
  // yet, so `currentSec` is still null — and gating on that alone meant the
  // very first press showed no spinner and, worse, left the bar's
  // press-again-to-cancel branch unreachable, so each further press re-armed
  // the wait instead of ending it.
  const active = video.currentSec != null || video.buffering
  const duration = video.durationSec != null && Number.isFinite(video.durationSec) ? video.durationSec : 0
  // Waiting to start. Not reported while it is already sounding: a picture that
  // rebuffers mid-play is the element's own business, and flipping the bar's
  // button to a spinner under a running film would be a lie about the transport.
  const loading = active && video.buffering && !video.playing
  return {
    active,
    playing: active && video.playing,
    // A cold start IS a dip to protect, exactly as it is for the queue —
    // follow/re-engage must not read the wait for a seek to land as a stop.
    running: active && (video.playing || loading),
    cellId: active ? video.soundingCellId : null,
    kind: active ? (video.playing ? "playing" : loading ? "loading" : "paused") : "idle",
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
