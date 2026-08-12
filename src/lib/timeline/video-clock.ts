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
// AQU-646 round 5: which line the picture is ON. Derived from the clock by
// `cellIdAtSec`, but stored rather than recomputed per consumer — the answer
// was previously local state inside MediaVideoPane, where the caption could see
// it and nothing else could, which is why the dialogue table never followed the
// film. Kept as an ID (not the second) so subscribers re-render on a LINE
// change, not on every one of timeupdate's ~4 ticks a second.
let soundingCellId: string | null = null
// Round 5: the playback bar reports and drives the picture, so its rate and
// volume have to be readable. Published from the element's own `ratechange` /
// `volumechange`, so the bar and the video's native controls can never
// disagree about what is set — whichever one the user reaches for, both show
// the same number.
let rate = 1
let volume = 1
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
  // A cleared clock is on no line either.
  const nextCell = next == null ? null : soundingCellId
  if (currentSec === next && playing === nextPlaying && soundingCellId === nextCell) return
  currentSec = next
  playing = nextPlaying
  soundingCellId = nextCell
  notify()
}

/** The line the picture is on, from `cellIdAtSec`. Null in a silence. */
export function setVideoSoundingCellId(next: string | null): void {
  if (soundingCellId === next) return
  soundingCellId = next
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

export function getVideoSoundingCellId(): string | null {
  return soundingCellId
}

export function setVideoRate(next: number): void {
  if (!Number.isFinite(next) || next <= 0 || rate === next) return
  rate = next
  notify()
}

export function setVideoVolume(next: number): void {
  const clamped = Math.max(0, Math.min(1, next))
  if (!Number.isFinite(next) || volume === clamped) return
  volume = clamped
  notify()
}

export function useVideoRate(): number {
  return useSyncExternalStore(subscribe, () => rate, () => 1)
}

export function useVideoVolume(): number {
  return useSyncExternalStore(subscribe, () => volume, () => 1)
}

/** TimelineEditor reads this and writes it into its clock ONLY while the queue
 *  is inactive, so the two drivers can never both be writing. */
export function useVideoClockSec(): number | null {
  return useSyncExternalStore(subscribe, () => currentSec, () => null)
}

export function useVideoClockPlaying(): boolean {
  return useSyncExternalStore(subscribe, () => playing, () => false)
}

export function useVideoSoundingCellId(): string | null {
  return useSyncExternalStore(subscribe, () => soundingCellId, () => null)
}

export function resetVideoClockForTests(): void {
  currentSec = null
  playing = false
  soundingCellId = null
  rate = 1
  volume = 1
  notify()
}
