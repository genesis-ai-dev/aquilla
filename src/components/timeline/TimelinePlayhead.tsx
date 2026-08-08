// The master-clock cursor. A thin vertical line at the current time with a
// gently breathing handle. Purely presentational; pointer-transparent.
//
// AQU-646: during playback the clock only ticks ~4×/sec (the audio element's
// timeupdate cadence) — at default zoom that's a visible ~10px stutter. When
// `playing`, a rAF loop interpolates between ticks by writing style.left
// directly (no React state, no re-renders); each `currentSec` prop change
// re-anchors the interpolation so drift can't accumulate.

import { useEffect, useLayoutEffect, useRef } from "react"
import { secToPx } from "@/lib/timeline/scale"

export interface TimelinePlayheadProps {
  currentSec: number
  pxPerSec: number
  /** Interpolate between clock ticks (audio playing). */
  playing?: boolean
  /** Playback speed multiplier for interpolation (default 1). */
  rate?: number
}

/** Smooth-playback round: how far past the last clock anchor the rAF may
 *  extrapolate. Ticks land ~every 250ms, so 0.45s never clamps healthy
 *  playback — but a clock that has silently stopped ticking (rebuffer, a
 *  loading verse, tab jank) PARKS the playhead just past its anchor instead
 *  of running away and snapping back when the next real tick lands. */
export const MAX_EXTRAPOLATION_SEC = 0.45

/** Pure interpolation math (exported for tests — rAF isn't testable). */
export function interpolatedSec(baseSec: number, baseT: number, now: number, rate: number): number {
  return baseSec + Math.min((now - baseT) / 1000, MAX_EXTRAPOLATION_SEC) * rate
}

/** 2026-08-08 (bounce forensics): corrections must render as a brief HOLD,
 *  never backward motion. Every boundary handoff lands the first
 *  authoritative anchor ~90ms behind the optimistic one (measured — a ~3px
 *  backward snap at EVERY verse), and extrapolation can overshoot a stalled
 *  clock by up to MAX_EXTRAPOLATION_SEC. While playing, a regression smaller
 *  than this bound holds the head still until the real clock catches up; a
 *  larger one is a genuine backward seek and passes through. Paused/idle
 *  rendering always follows the clock exactly. */
export const MAX_REGRESSION_SEC = 0.5

/** Pure monotonic clamp (exported for tests). The pass-through bound must
 *  cover the worst extrapolation overshoot, which scales with playback RATE
 *  (interpolatedSec caps at MAX_EXTRAPOLATION_SEC * rate) — a fixed bound
 *  re-opened the backward snap at 1.25x+ after a mid-verse stall. */
export function monotonicSec(
  prevRenderedSec: number | null,
  nextSec: number,
  playing: boolean,
  rate = 1,
): number {
  if (!playing || prevRenderedSec == null || nextSec >= prevRenderedSec) return nextSec
  const bound = Math.max(MAX_REGRESSION_SEC, MAX_EXTRAPOLATION_SEC * rate + 0.05)
  return prevRenderedSec - nextSec < bound ? prevRenderedSec : nextSec
}

export function TimelinePlayhead({ currentSec, pxPerSec, playing = false, rate = 1 }: TimelinePlayheadProps) {
  const elRef = useRef<HTMLDivElement>(null)
  /** The last second this component actually PAINTED — the monotonic floor. */
  const renderedSecRef = useRef<number | null>(null)

  // Sync the floor with what THIS commit's JSX just painted — synchronously,
  // before any rAF frame can fire. Without this, a forward anchor written by
  // React outruns the rAF-owned floor and the OLD loop's next frame pulls
  // the head back for one frame (the residual 1-frame bounce the live pass
  // caught). While paused, monotonicSec passes currentSec through exactly.
  useLayoutEffect(() => {
    renderedSecRef.current = monotonicSec(renderedSecRef.current, currentSec, playing, rate)
  })

  useEffect(() => {
    if (!playing) return
    const el = elRef.current
    if (!el) return
    const baseSec = currentSec
    const baseT = performance.now()
    let raf = 0
    const step = () => {
      const sec = monotonicSec(renderedSecRef.current, interpolatedSec(baseSec, baseT, performance.now(), rate), true, rate)
      renderedSecRef.current = sec
      el.style.left = `${secToPx(sec, pxPerSec)}px`
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
      style={{ left: `${secToPx(monotonicSec(renderedSecRef.current, currentSec, playing, rate), pxPerSec)}px` }}
    >
      <span className="absolute -left-[5px] -top-px h-0 w-0 border-[5px] border-transparent border-t-red-500 motion-safe:animate-pulse" />
    </div>
  )
}
