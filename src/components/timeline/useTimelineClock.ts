// Master-clock transport for the timeline editor. When a linked video is
// present the <video> element drives `setCurrentSec` via onTimeUpdate, and
// `seekTo` is mirrored onto the element by the editor. With no video the clock
// is just a draggable position cursor. Pure state; no timers here.

import { useCallback, useState } from "react"

export interface TimelineClock {
  currentSec: number
  playing: boolean
  /** Driven by the video element's timeupdate (no clamping needed there). */
  setCurrentSec(sec: number): void
  /** User seek (ruler scrub / keyboard). Clamps to >= 0. */
  seekTo(sec: number): void
  play(): void
  pause(): void
  toggle(): void
}

export function useTimelineClock(initialSec = 0): TimelineClock {
  const [currentSec, setCurrentSec] = useState(initialSec)
  const [playing, setPlaying] = useState(false)

  const seekTo = useCallback((sec: number) => {
    setCurrentSec(Number.isFinite(sec) ? Math.max(0, sec) : 0)
  }, [])
  const play = useCallback(() => setPlaying(true), [])
  const pause = useCallback(() => setPlaying(false), [])
  const toggle = useCallback(() => setPlaying((p) => !p), [])

  return { currentSec, playing, setCurrentSec, seekTo, play, pause, toggle }
}
