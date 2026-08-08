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

import { useSyncExternalStore } from "react"

let currentSec: number | null = null
const listeners = new Set<() => void>()

/** MediaVideoPane's standalone arrangement calls this from `timeupdate`. */
export function setVideoClockSec(sec: number | null): void {
  const next = sec == null || !Number.isFinite(sec) ? null : Math.max(0, sec)
  if (currentSec === next) return
  currentSec = next
  for (const l of listeners) l()
}

export function getVideoClockSec(): number | null {
  return currentSec
}

/** TimelineEditor reads this and writes it into its clock ONLY while the queue
 *  is inactive, so the two drivers can never both be writing. */
export function useVideoClockSec(): number | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    () => currentSec,
    () => null,
  )
}

export function resetVideoClockForTests(): void {
  currentSec = null
  for (const l of listeners) l()
}
