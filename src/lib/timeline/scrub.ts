// Dragging the playhead. (AQU-646 stage 5)
//
// Sam, 2026-08-26: "when the actual playhead is dragged around, it should scrub
// both the audio and the video if present." The audio half he then ruled out —
// the picture scrubs, nothing sounds — so what is left is a gesture that turns
// a pointer position into a second, over and over, cheaply.
//
// The arithmetic lives here, apart from the gesture, for the same reason
// `video-sync.ts` is a pure function over an explicit record: happy-dom gives
// every element a 0x0 rect and an inert media element, so anything that reached
// for the DOM would take the do-nothing branch and pass green while asserting
// the opposite. What CAN be proved without a browser is that the pointer maps
// to the right second and that the answer is always inside the file.

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * The same 3px `TimelineCard`, `TargetAudioLane` and `beginTrackDrag` all use,
 * and it is load-bearing twice over here. A press that never passes it stays a
 * CLICK — which on this element already means "seek here" and must keep meaning
 * exactly that, unchanged, including that it does not stop playback. Only past
 * the threshold does the gesture take the transport.
 */
export const SCRUB_INTENT_PX = 3

/**
 * How often a scrub is allowed to cross into the workspace.
 *
 * Not about the picture — the element has its own coalescer for that — but
 * about `setVideoSeek`, which is React state on an eleven-thousand-line
 * component, so every crossing re-renders that tree. ~16 times a second is
 * indistinguishable from continuous to a hand moving a playhead and an order of
 * magnitude cheaper than a pointer stream.
 */
export const SCRUB_SEEK_THROTTLE_MS = 60

/**
 * The file-second under the pointer, clamped to the file.
 *
 * THE UPPER CLAMP IS NOT TIDINESS. A click cannot land outside the element it
 * is on, so the click-to-seek this replaces never needed one; a drag holds
 * POINTER CAPTURE and therefore keeps reporting from anywhere on screen,
 * including far past the end of the track. An unclamped second reaches
 * `startQueueAtTime`, which finds no cell owning it and falls through to the
 * first playable one — so overshooting the end of a 70-minute episode would
 * silently yank the queue back to line one.
 *
 * A duration that is not a positive finite number means "not reported yet"
 * (an element that has not loaded, a file with no timings). Clamping to it
 * would pin every answer to zero, so in that state only the lower bound
 * applies and the caller gets an honest second for a track that has no end.
 */
export function scrubSecAt(args: {
  clientX: number
  /** The scrub surface's left edge, read LIVE — it is sticky over a scroller. */
  rectLeft: number
  pxPerSec: number
  durationSec: number
}): number {
  const { clientX, rectLeft, pxPerSec, durationSec } = args
  if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return 0
  if (!Number.isFinite(clientX) || !Number.isFinite(rectLeft)) return 0
  const sec = (clientX - rectLeft) / pxPerSec
  if (!Number.isFinite(sec)) return 0
  const lower = Math.max(0, sec)
  return Number.isFinite(durationSec) && durationSec > 0 ? Math.min(lower, durationSec) : lower
}
