// Never let two seeks be in flight on the same <video>. (AQU-646 stage 5)
//
// Dragging the playhead asks the picture to move continuously, and hls.js has a
// documented way of dying under that: `useHlsVideo`'s own header says that
// "after a burst of seeks it stops producing frames without firing an event" —
// no error, no stall event, just a frozen picture that the pane's watchdog then
// has to climb out of.
//
// THE OBVIOUS GUARD IS A WALL-CLOCK THROTTLE, AND IT IS A GUESS. Pick 120ms and
// a healthy H.264 file stutters for no reason; pick it and a struggling 4K
// ladder still gets eight overlapping seeks a second, which is the burst. The
// pipeline's own readiness is the only honest signal, so this waits on it: while
// the element is `seeking`, hold the newest target and issue nothing; when it
// settles, issue whatever is being held. One seek in flight, always, and it
// self-tunes — a fast local file scrubs smoothly, a slow stream degrades to as
// many seeks as it can actually serve.
//
// The trailing edge falls out rather than needing a timer: the last target the
// user asked for is the one sitting in `pendingSec`, so the drain on `seeked` is
// what guarantees the picture ends up where the hand stopped.
//
// NOT `VIDEO_SEEK_COOLDOWN_MS`. That constant answers a different question — its
// comment says it exists so "a pathological clock can't seek-storm" — and
// `videoSyncAction` deliberately exempts the paused case from it with the words
// "scrubbing the ruler must move the picture… paused seeks always land". Reusing
// it here would contradict a rule written in anticipation of this feature.
//
// Pure, and over the element's OWN `seeking` flag rather than a record we keep
// of what we issued. That is deliberate: if a `seeked` is ever missed — an
// error, a source swap, a rebuild after a stall — our own bookkeeping would
// deadlock and the picture would stop following forever, whereas reading the
// live flag self-heals on the very next request.

export interface ScrubSeekInput {
  /** The element's live `seeking` flag. */
  seeking: boolean
  /** A target held back by an earlier request, if any. */
  pendingSec: number | null
  /** The new target, or null when this is the element reporting `seeked`. */
  requestSec: number | null
}

export interface ScrubSeekOutput {
  /** Write this to `currentTime` now. Null means do nothing. */
  seekSec: number | null
  /** The target to carry forward. */
  pendingSec: number | null
}

export function nextScrubSeek(input: ScrubSeekInput): ScrubSeekOutput {
  const { seeking, pendingSec, requestSec } = input

  // A new target.
  if (requestSec != null) {
    // A target that is not a real second cannot be written and must not evict
    // a good one that is already waiting.
    if (!Number.isFinite(requestSec)) return { seekSec: null, pendingSec }
    if (seeking) return { seekSec: null, pendingSec: requestSec }
    return { seekSec: requestSec, pendingSec: null }
  }

  // The element settled. Drain whatever the user asked for meanwhile.
  if (pendingSec != null) return { seekSec: pendingSec, pendingSec: null }
  return { seekSec: null, pendingSec: null }
}
