// The master-clock cursor. A thin vertical line at the current time with a
// gently breathing handle. Purely presentational; pointer-transparent.
//
// AQU-646: during playback the clock only ticks ~4×/sec (the audio element's
// timeupdate cadence) — at default zoom that's a visible ~10px stutter. When
// `playing`, a rAF loop interpolates between ticks by writing style.left
// directly (no React state, no re-renders); each `currentSec` prop change
// re-anchors the interpolation so drift can't accumulate.

import { useEffect, useRef } from "react"
import { secToPx } from "@/lib/timeline/scale"

export interface TimelinePlayheadProps {
  currentSec: number
  pxPerSec: number
  /** Interpolate between clock ticks (audio playing). */
  playing?: boolean
  /** Playback speed multiplier for interpolation (default 1). */
  rate?: number
}

/** Pure interpolation math (exported for tests — rAF isn't testable). */
export function interpolatedSec(baseSec: number, baseT: number, now: number, rate: number): number {
  return baseSec + ((now - baseT) / 1000) * rate
}

export function TimelinePlayhead({ currentSec, pxPerSec, playing = false, rate = 1 }: TimelinePlayheadProps) {
  const elRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!playing) return
    const el = elRef.current
    if (!el) return
    const baseSec = currentSec
    const baseT = performance.now()
    let raf = 0
    const step = () => {
      el.style.left = `${secToPx(interpolatedSec(baseSec, baseT, performance.now(), rate), pxPerSec)}px`
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, currentSec, pxPerSec, rate])

  return (
    <div
      ref={elRef}
      data-testid="tl-playhead"
      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-red-500"
      style={{ left: `${secToPx(currentSec, pxPerSec)}px` }}
    >
      <span className="absolute -left-[5px] -top-px h-0 w-0 border-[5px] border-transparent border-t-red-500 motion-safe:animate-pulse" />
    </div>
  )
}
