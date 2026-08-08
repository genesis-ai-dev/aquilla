// Deciding when a slaved <video> must be repositioned against the play queue.
// (AQU-646)
//
// The queue is the master clock; the linked video is a muted picture surface
// that follows it. The naive way to follow — compare `video.currentTime` to the
// queue's published time and seek whenever they differ by more than some bar —
// is wrong here, and expensively so:
//
//   The queue's only continuous tick is the master audio element's `timeupdate`,
//   which fires roughly every 250ms of WALL time. So the published time always
//   lags the true playback head by up to 0.25 * rate media-seconds, while a
//   freewheeling <video> at the same playbackRate sits AT the head. Comparing
//   the two makes the lag look like drift: at 1.5x the gap reaches 0.375s and at
//   2x it reaches 0.5s, so any fixed bar in that neighbourhood seeks on nearly
//   every tick — and each "correction" drags the picture BEHIND the sound, which
//   is the opposite of what it set out to fix.
//
// So this never reads the element. It compares each tick to where the PREVIOUS
// tick predicted this one would land: the lag is present in both and cancels.
// What survives is only genuine discontinuity — a seek, a cross-clip adopt, a
// stall — which is exactly when a reposition is warranted. A muted video at a
// matching playbackRate reproduces the freewheel between those points for free.
//
// Being a pure function over an explicit record is also the only way this can be
// tested: happy-dom's HTMLMediaElement is inert (currentTime never advances, no
// timeupdate ever fires), so anything that reached for the element would take
// the do-nothing branch and pass green while asserting the opposite.

import { interpolatedSec } from "./TimelinePlayhead"
import type { QueueState } from "@/lib/audio/play-queue"

export type VideoSyncAction =
  /** Hard stop: pause and do NOT write currentTime. */
  | { kind: "pause" }
  /** Reposition to `sec`. The caller still decides play vs pause. */
  | { kind: "seek"; sec: number }
  /** Leave the element alone — it is freewheeling correctly. */
  | { kind: "none" }

/** How far a tick may sit from its prediction before it counts as a real
 *  discontinuity rather than tick jitter. Comfortably above the ~250ms tick
 *  interval so ordinary playback never trips it. */
export const VIDEO_SEEK_BAR_SEC = 0.5

/** While paused nothing should be moving, so any change at all is a seek —
 *  scrubbing the ruler must move the picture. Small enough to be exact,
 *  large enough to ignore float noise. */
export const VIDEO_PAUSED_SNAP_SEC = 0.05

/** Seeks are expensive (a keyframe hunt, often a visible flash). Never issue
 *  them faster than this, so a pathological clock can't seek-storm. */
export const VIDEO_SEEK_COOLDOWN_MS = 400

/** How close to the video's end counts as "the audio has outrun the picture".
 *  Seeking into the final moments tends to land past the last keyframe and
 *  stall; holding the last frame reads better. */
export const VIDEO_END_GUARD_SEC = 0.25

export interface VideoSyncInput {
  /** Queue state ALREADY scoped to this file (see queue-scope.ts). */
  kind: QueueState["kind"]
  /** False when the queue's master is a per-cell take, whose clock restarts at
   *  0 and is therefore not a position on the file at all. */
  clockIsFileTime: boolean
  /** The queue's newest published time. */
  tickSec: number
  /** The previous published time, and when we observed it (ms). */
  prevTickSec: number | null
  prevTickAt: number | null
  now: number
  rate: number
  /** `video.duration` — NaN until metadata loads. */
  duration: number
  lastSeekAt: number | null
}

export function videoSyncAction(input: VideoSyncInput): VideoSyncAction {
  const { kind, clockIsFileTime, tickSec, prevTickSec, prevTickAt, now, rate, duration, lastSeekAt } = input

  // The queue zeroes its progress when it disposes the master — at end of file,
  // on stop, and on error. Reading that as a position would rewind the film the
  // moment playback finishes, so terminal states never write position at all.
  if (kind === "idle" || kind === "error") return { kind: "pause" }

  if (!clockIsFileTime) return { kind: "pause" }

  // Metadata not in yet (or a broken file): nothing is seekable.
  if (!Number.isFinite(duration) || duration <= 0) return { kind: "pause" }

  // The dub is longer than the footage, or we're at the very tail — hold.
  if (tickSec > duration - VIDEO_END_GUARD_SEC) return { kind: "pause" }

  // A cross-clip resolve republishes progress transiently; the queue re-seeds
  // the clock to the landing target synchronously, so chasing it here would
  // only seek to a value about to be replaced.
  if (kind === "loading") return { kind: "none" }

  const target = Math.max(0, tickSec)

  // Nothing to predict from yet — anchor.
  if (prevTickSec == null || prevTickAt == null) return { kind: "seek", sec: target }

  // While paused nothing advances, so the prediction is simply "unchanged".
  const playing = kind === "playing"
  const expected = playing ? interpolatedSec(prevTickSec, prevTickAt, now, rate) : prevTickSec
  const bar = playing ? VIDEO_SEEK_BAR_SEC : VIDEO_PAUSED_SNAP_SEC

  const discontinuous = tickSec < prevTickSec || Math.abs(tickSec - expected) > bar
  if (!discontinuous) return { kind: "none" }

  if (lastSeekAt != null && now - lastSeekAt < VIDEO_SEEK_COOLDOWN_MS) return { kind: "none" }
  return { kind: "seek", sec: target }
}
