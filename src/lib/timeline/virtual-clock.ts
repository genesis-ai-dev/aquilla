// A transport for files that have TIMINGS but no master. (AQU-646 stage 3h)
//
// Sam, 2026-08-25: "the timeline playhead does not move when just vtts are
// imported. This makes sense cuz there isn't real 'media' there, but vtts do
// have time data and I believe that therefore pressing play even when there
// isn't a film should cause the playhead to move along and any recorded or
// tts'd takes to play."
//
// He is right, and the reason nothing moved is honest rather than broken: the
// playhead has exactly two writers, and a VTT-only file has neither. The QUEUE
// only publishes a FILE position while an imported source recording is the
// master — on a take its clock restarts at zero per take, and writing that
// would yank the playhead to zero every time one sounded. The VIDEO publishes
// one when a film is linked. With no recording and no film there is no master
// at all.
//
// THIS IS NOT A THIRD PLAYER, and that is the whole reason it is small. The dub
// driver in play-queue says so itself: the overlay pool, the fires, the trims
// and the audibility sweep are already clock-agnostic, and `planTargetOverlay`
// already takes the master's second as a plain parameter — "only the thing that
// TICKS changes". A film drives that engine today by calling `tickExternalDubs`
// once per clock tick. So what was missing is a CLOCK, and this is it.
//
// ANCHORED TO THE WALL CLOCK, NOT COUNTING TICKS. The position is computed from
// `performance.now()` against an anchor rather than accumulated per tick, so a
// throttled or dropped tick self-corrects instead of compounding into drift.
// That is not hypothetical: a background tab throttles timers hard while the
// `<audio>` elements keep playing at full speed, and a counted clock would slide
// further out of step with the sound the longer you looked away.
//
// A MODULE STORE rather than React state, for the reason `video-clock.ts` gives
// beside it: this ticks several times a second and the only consumers are one
// number in the timeline and one in the playback bar. Routing it through the
// workspace would re-render that whole tree on every tick.

import { useSyncExternalStore } from "react"
import type { VideoController } from "./video-controller"

/**
 * How often the position is republished.
 *
 * Deliberately coarse. The playhead runs its own rAF interpolation between
 * updates — it has to, because a video's `timeupdate` only fires ~4Hz — so this
 * rate does not decide how smooth the head looks. It decides how promptly a dub
 * fires, and 20Hz is well inside the tolerance for that while costing a
 * subscriber notification rather than a render.
 */
const TICK_MS = 50

let anchorSec = 0
let anchorMs = 0
/**
 * THE NUMBER `getSnapshot` HANDS OUT, and it must be a stored value rather than
 * a computed one.
 *
 * `useSyncExternalStore` asks for the snapshot during render and again to check
 * nothing moved underneath it; if the two answers differ React concludes it is
 * in an infinite loop and throws. This used to return `computeSec()` directly,
 * which reads `performance.now()` — a different number every call — so the
 * first render after pressing play threw and the app showed its error page.
 * (It only failed while PLAYING: paused, `computeSec` early-returns the anchor,
 * which is stable, which is why everything looked fine until the press.)
 *
 * `video-clock.ts` beside this never had the problem because an element pushes
 * values in and it stores them. Computing from a clock is the difference, and
 * this is the variable that pays for it.
 */
let publishedSec = 0
let playing = false
let rate = 1
let volume = 1
/** End of the last cue. Playback stops here (Sam: no looping). 0 = unknown. */
let durationSec = 0
/** Null when nothing is driving — the file has a master of its own, or none of
 *  this applies. Mirrors `video-clock`'s "cleared" state exactly. */
let driving = false
let timer: ReturnType<typeof setInterval> | null = null

const listeners = new Set<() => void>()

/**
 * Republish, then wake the subscribers — in that order, always.
 *
 * Folded into one function on purpose. Every mutator below has to refresh the
 * stored snapshot before it notifies, and "remember to call publish() first" is
 * the kind of rule that survives exactly as long as the person who wrote it.
 * There is no `notify` without a `publish` because there is no `notify`.
 */
function notify(): void {
  publish()
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Where the clock reads right now, from the anchor and the wall clock. */
function computeSec(): number {
  if (!playing) return anchorSec
  const elapsed = (performance.now() - anchorMs) / 1000
  const raw = anchorSec + elapsed * rate
  return durationSec > 0 ? Math.min(raw, durationSec) : raw
}

/** Re-anchor at the CURRENT position. Called on every change that would
 *  otherwise make elapsed-time-since-anchor mean something different: play,
 *  pause, seek, and a rate change mid-flight. */
function reanchor(sec = computeSec()): void {
  anchorSec = Math.max(0, sec)
  anchorMs = performance.now()
}

/** Refresh the stored snapshot from the live maths. Called before every
 *  `notify`, so a subscriber always reads a value that stays put until the next
 *  notification. */
function publish(): void {
  publishedSec = driving ? computeSec() : 0
}

function stopTimer(): void {
  if (timer == null) return
  clearInterval(timer)
  timer = null
}

/**
 * One beat: republish the position, and stop at the end.
 *
 * EXPORTED so tests can drive the clock without timers — which is not merely
 * convenient. The bug this file shipped with lived in exactly this path (the
 * published snapshot), and a test that read the maths directly could never see
 * it. Driving the real tick is what makes the tests cover the thing that broke.
 */
export function tickVirtualClock(): void {
  if (!driving) return
  // Reaching the end STOPS, it does not wrap (Sam: "runs to end of last cue").
  // The position is left at the end rather than reset, the way a media element
  // leaves it, so pressing play again does not silently restart from zero.
  if (playing && durationSec > 0 && computeSec() >= durationSec) {
    reanchor(durationSec)
    playing = false
    stopTimer()
  }
  notify()
}

function startTimer(): void {
  if (timer != null) return
  timer = setInterval(tickVirtualClock, TICK_MS)
}

/** Take the transport. Idempotent; refreshes the duration. */
export function startVirtualClock(duration: number): void {
  durationSec = Number.isFinite(duration) && duration > 0 ? duration : 0
  if (driving) {
    notify()
    return
  }
  driving = true
  playing = false
  reanchor(0)
  notify()
}

/** Hand it back — a film arrived, the file changed, the lens closed. */
export function stopVirtualClock(): void {
  if (!driving) return
  stopTimer()
  driving = false
  playing = false
  anchorSec = 0
  notify()
}

export function virtualClockPlay(): void {
  if (!driving || playing) return
  // Pressing play at the very end restarts, which is what a media element does
  // and what the button plainly means there.
  if (durationSec > 0 && anchorSec >= durationSec) anchorSec = 0
  playing = true
  reanchor(anchorSec)
  startTimer()
  notify()
}

export function virtualClockPause(): void {
  if (!driving || !playing) return
  reanchor()
  playing = false
  stopTimer()
  notify()
}

export function virtualClockSeek(sec: number): void {
  if (!driving) return
  const clamped = Number.isFinite(sec) ? Math.max(0, durationSec > 0 ? Math.min(sec, durationSec) : sec) : 0
  reanchor(clamped)
  notify()
}

/** Rate re-anchors FIRST, so the seconds already elapsed keep their old rate
 *  rather than being retroactively rescaled. */
export function setVirtualClockRate(next: number): void {
  if (!Number.isFinite(next) || next <= 0 || rate === next) return
  reanchor()
  rate = next
  notify()
}

export function setVirtualClockVolume(next: number): void {
  const clamped = Math.max(0, Math.min(1, next))
  if (!Number.isFinite(next) || volume === clamped) return
  volume = clamped
  notify()
}

export function getVirtualClockSec(): number | null {
  return driving ? publishedSec : null
}

export function getVirtualClockPlaying(): boolean {
  return driving && playing
}

/**
 * The command surface, in the shape the playback bar already speaks.
 *
 * REGISTERED INTO `video-controller.ts` BY THE WORKSPACE while this owns the
 * file, and that is the design decision worth defending. The bar branches
 * `drivesVideo ? videoController?.x() : queueX()` in six places; a third arm in
 * each is six chances to wire one to the wrong half, which is the exact failure
 * `transport.ts` was written to end. Registering here instead keeps every one
 * of those branches two-way.
 *
 * It also buys a bug that would otherwise have to be found: opening the
 * recorder calls `getVideoController()?.pause()`, so a transport that did not
 * register would keep playing underneath a take.
 */
export const virtualClockController: VideoController = {
  play: virtualClockPlay,
  pause: virtualClockPause,
  isPaused: () => !getVirtualClockPlaying(),
  seek: virtualClockSeek,
  setRate: setVirtualClockRate,
  setVolume: setVirtualClockVolume,
}

export function useVirtualClockSec(): number | null {
  return useSyncExternalStore(subscribe, getVirtualClockSec, () => null)
}

export function useVirtualClockPlaying(): boolean {
  return useSyncExternalStore(subscribe, getVirtualClockPlaying, () => false)
}

export function useVirtualClockRate(): number {
  return useSyncExternalStore(subscribe, () => rate, () => 1)
}

export function useVirtualClockVolume(): number {
  return useSyncExternalStore(subscribe, () => volume, () => 1)
}

export function useVirtualClockDuration(): number {
  return useSyncExternalStore(subscribe, () => durationSec, () => 0)
}

export function resetVirtualClockForTests(): void {
  stopTimer()
  driving = false
  playing = false
  anchorSec = 0
  anchorMs = 0
  rate = 1
  volume = 1
  durationSec = 0
  notify()
}

/**
 * DEV seam for the browser passes, beside `__aqQueueState` and
 * `__aqExternalDubs`. Same reasoning as theirs: a pass must read the LIVE
 * module, and a bare-path dynamic import from `page.evaluate` can resolve to a
 * second instance once HMR has stamped the graph.
 */
export function getVirtualClockSnapshot(): {
  driving: boolean
  playing: boolean
  sec: number | null
  durationSec: number
  rate: number
} {
  return { driving, playing, sec: getVirtualClockSec(), durationSec, rate }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  ;(window as unknown as Record<string, unknown>).__aqVirtualClock = getVirtualClockSnapshot
}
