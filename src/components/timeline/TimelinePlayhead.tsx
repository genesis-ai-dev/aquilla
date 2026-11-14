// The master-clock cursor. A thin vertical line at the current time with a
// gently breathing handle. Purely presentational; pointer-transparent.
//
// AQU-646: during playback the clock only ticks ~4×/sec (the audio element's
// timeupdate cadence) — at default zoom that's a visible ~10px stutter. When
// `playing`, one rAF loop runs for the whole of playback and writes style.left
// directly (no React state, no re-renders). It FOLLOWS the clock rather than
// restarting from each tick: see `followFrame`.

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

/** A gap between the head and the clock at least this big is a seek, and the
 *  head goes straight there. It must cover the worst extrapolation overshoot,
 *  which scales with playback RATE (interpolatedSec caps at
 *  MAX_EXTRAPOLATION_SEC * rate) — a fixed bound re-opened the backward snap at
 *  1.25x+ after a mid-verse stall. */
export function seekBoundSec(rate: number): number {
  return Math.max(MAX_REGRESSION_SEC, MAX_EXTRAPOLATION_SEC * rate + 0.05)
}

/** How quickly the head closes on the clock: about two thirds of a gap is
 *  gone in this long. Under the ~250ms between ticks, so the head is where the
 *  clock is before the next one lands. */
export const FOLLOW_TAU_SEC = 0.15

export interface FollowedHead {
  /** The second drawn. */
  sec: number
  /** The frame it was drawn on (performance.now()). */
  at: number
}

/**
 * One frame of the head while playing. Pure; exported for tests.
 *
 * The head advances at the playback rate and then closes part of the gap to
 * where the clock says it should be by now. Each tick reaches here a frame or
 * two after the element sampled it, so a tick restarting the extrapolation
 * always landed a little BEHIND the head. Held to never moving backward, the
 * head stopped dead until the clock caught up — a hitch four times a second,
 * bigger the further in you zoom. Following instead, a late tick slows the
 * head for a moment, and nothing stops it.
 *
 * It still never moves backward while playing. A clock that stops ticking
 * parks it a little past where it was (the extrapolation is capped), and a gap
 * of a seek's size jumps to the clock.
 */
export function followFrame(
  prev: FollowedHead,
  clockSec: number,
  clockAt: number,
  now: number,
  rate: number,
): FollowedHead {
  const target = interpolatedSec(clockSec, clockAt, now, rate)
  const dt = Math.max(0, (now - prev.at) / 1000)
  const coasted = prev.sec + dt * rate
  const gap = target - coasted
  if (Math.abs(gap) >= seekBoundSec(rate)) return { sec: target, at: now }
  const pulled = coasted + gap * (1 - Math.exp(-dt / FOLLOW_TAU_SEC))
  return { sec: Math.max(prev.sec, pulled), at: now }
}

export function TimelinePlayhead({ currentSec, pxPerSec, playing = false, rate = 1 }: TimelinePlayheadProps) {
  const elRef = useRef<HTMLDivElement>(null)
  /** What the head last painted. The rAF owns it while playing. */
  const headRef = useRef<FollowedHead | null>(null)
  /** The clock's latest second, and when it reached this component. */
  const clockRef = useRef({ sec: currentSec, at: 0 })
  const pxPerSecRef = useRef(pxPerSec)
  const rateRef = useRef(rate)

  // While playing, a render draws where the head IS, not where the tick
  // says: the loop is easing toward the tick, and a commit that jumped there
  // would undo it. A gap of a seek's size is a seek, and lands at once.
  const head = headRef.current
  const drawnSec = playing && head && Math.abs(currentSec - head.sec) < seekBoundSec(rate) ? head.sec : currentSec

  useLayoutEffect(() => {
    pxPerSecRef.current = pxPerSec
    rateRef.current = rate
    const now = performance.now()
    if (clockRef.current.sec !== currentSec || clockRef.current.at === 0) clockRef.current = { sec: currentSec, at: now }
    headRef.current = { sec: drawnSec, at: headRef.current?.at ?? now }
  })

  useEffect(() => {
    if (!playing) return
    const el = elRef.current
    if (!el) return
    let raf = 0
    const step = (frameAt: number) => {
      const prev = headRef.current ?? { sec: clockRef.current.sec, at: frameAt }
      const clock = clockRef.current
      const next = followFrame({ sec: prev.sec, at: Math.min(prev.at, frameAt) }, clock.sec, clock.at, frameAt, rateRef.current)
      headRef.current = next
      el.style.left = `${secToPx(next.sec, pxPerSecRef.current)}px`
      raf = requestAnimationFrame(step)
    }
    // Playback starts from here and now: a clock or a head stamped before a
    // pause would read the whole pause as time already played.
    const startedAt = performance.now()
    clockRef.current = { sec: clockRef.current.sec, at: startedAt }
    if (headRef.current) headRef.current = { ...headRef.current, at: startedAt }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  return (
    <div
      ref={elRef}
      data-testid="tl-playhead"
      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-red-500"
      style={{ left: `${secToPx(drawnSec, pxPerSec)}px` }}
    >
      <span className="absolute -left-[5px] -top-px h-0 w-0 border-[5px] border-transparent border-t-red-500 motion-safe:animate-pulse" />
    </div>
  )
}
