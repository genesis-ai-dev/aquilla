// Position cursor for the timeline editor. Pure state; no timers here.
//
// AQU-646: the play queue is the master clock and drives `setCurrentSec` while
// it is active. A file with a linked video but NO audio at all can never start
// the queue, and there the video pane drives this instead — so there are two
// possible writers, and which one is in charge is decided by whether the queue
// is active, never by both writing at once (which is what used to happen).

import { useCallback, useState } from "react"

export interface TimelineClock {
  currentSec: number
  playing: boolean
  /** Driven by whichever transport owns the clock (no clamping needed there). */
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
