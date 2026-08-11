// The fallback clock: a linked video's own playback position, published as a
// tiny module store (the media-cursor.ts / selection.ts pattern). (AQU-646)
//
// The play queue is the master clock everywhere it can run. It cannot run at
// all for a file that has a linked video and no audio attachments — a subtitle
// file being timed against its footage, which is the case "Link video" was
// built for — and there the video keeps its native controls and drives the
// playhead itself.
//
// This goes through a store rather than React state in ProjectWorkspace because
// `timeupdate` fires several times a second: routing it through the workspace
// would re-render that whole tree on every tick, when the only consumer is one
// number inside the timeline.
//
// 2026-08-11: the store also carries PLAYING. `timeupdate` only fires ~4Hz, so
// a playhead driven by position alone advances in visible steps; the timeline's
// rAF interpolation needs to know the transport is running before it will
// smooth between them. It used to read that from the queue, which is idle in
// exactly this arrangement — so the playhead never glided for a linked video.

import { useSyncExternalStore } from "react"

let currentSec: number | null = null
let playing = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** MediaVideoPane's standalone arrangement calls this from `timeupdate`. */
export function setVideoClockSec(sec: number | null): void {
  const next = sec == null || !Number.isFinite(sec) ? null : Math.max(0, sec)
  // A cleared clock cannot be playing. The pane pushes null to hand the
  // transport back to the queue (or on unmount), and a stale `true` would keep
  // the playhead extrapolating from a position nobody updates any more.
  const nextPlaying = next == null ? false : playing
  if (currentSec === next && playing === nextPlaying) return
  currentSec = next
  playing = nextPlaying
  notify()
}

/** Standalone `play`/`pause`/`ended`. Ignored while the clock is cleared. */
export function setVideoClockPlaying(next: boolean): void {
  if (playing === next) return
  playing = next
  notify()
}

export function getVideoClockSec(): number | null {
  return currentSec
}

export function getVideoClockPlaying(): boolean {
  return playing
}

/** TimelineEditor reads this and writes it into its clock ONLY while the queue
 *  is inactive, so the two drivers can never both be writing. */
export function useVideoClockSec(): number | null {
  return useSyncExternalStore(subscribe, () => currentSec, () => null)
}

export function useVideoClockPlaying(): boolean {
  return useSyncExternalStore(subscribe, () => playing, () => false)
}

export function resetVideoClockForTests(): void {
  currentSec = null
  playing = false
  notify()
}
