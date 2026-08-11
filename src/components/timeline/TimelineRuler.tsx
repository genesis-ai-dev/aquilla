// The time ruler. Renders "nice"-spaced ticks with monospaced labels and turns
// a click into a seek (onScrub, seconds). Width tracks the zoomed duration.
//
// 2026-08-11: two standing fixes, neither caused by the source-audio band but
// both made worse by it.
//   - The duration is CLAMPED. A media element that has not reported yet gives
//     `durationSec` as NaN or Infinity, and `width: Infinitypx` silently kills
//     the whole track — no ruler, no lanes, no playhead.
//   - The tick loop is WINDOWED. Every tick is a positioned div carrying a
//     label; a 70-minute file at the default zoom asks for ~2,100 of them on
//     every render, and the lanes beside it have windowed since SUB-18.
// Both callers-optional: with no window the output is byte-identical to before.

import { memo } from "react"
import { secToPx, pxToSec } from "@/lib/timeline/scale"
import { fmtClock, niceTickSec } from "./format"

export interface TimelineRulerProps {
  durationSec: number
  pxPerSec: number
  /** Visible window in track seconds. Omitted = draw every tick. */
  viewStartSec?: number
  viewEndSec?: number
  onScrub(sec: number): void
}

function TimelineRulerImpl({
  durationSec,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  onScrub,
}: TimelineRulerProps) {
  const step = niceTickSec(pxPerSec)
  // Non-finite/negative means "not reported yet" — fall back to a one-step
  // track rather than an infinitely wide one.
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const spanSec = Math.max(safeDuration, step)
  const from = Number.isFinite(viewStartSec) ? Math.max(0, viewStartSec as number) : 0
  const to = Number.isFinite(viewEndSec) ? Math.min(spanSec, viewEndSec as number) : spanSec
  const ticks: number[] = []
  // Snap the first tick DOWN onto the step grid: a label must sit at the same
  // absolute second whatever the window happens to start at, or the numbers
  // slide around as you scroll.
  for (let t = Math.floor(from / step) * step; t <= to; t += step) ticks.push(t)
  const width = secToPx(spanSec, pxPerSec)

  return (
    <div
      data-testid="tl-ruler"
      className="relative h-7 select-none border-b border-border bg-muted/30"
      style={{ width: `${width}px` }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onScrub(pxToSec(e.clientX - rect.left, pxPerSec))
      }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute inset-y-0 border-l border-border/70"
          style={{ left: `${secToPx(t, pxPerSec)}px` }}
        >
          <span className="absolute left-1 top-1 font-mono text-[10px] tabular-nums text-muted-foreground">
            {fmtClock(t)}
          </span>
        </div>
      ))}
    </div>
  )
}

export const TimelineRuler = memo(TimelineRulerImpl)
