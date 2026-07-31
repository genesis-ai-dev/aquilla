// The time ruler. Renders "nice"-spaced ticks with monospaced labels and turns
// a click into a seek (onScrub, seconds). Width tracks the zoomed duration.

import { secToPx, pxToSec } from "@/lib/timeline/scale"
import { fmtClock, niceTickSec } from "./format"

export interface TimelineRulerProps {
  durationSec: number
  pxPerSec: number
  onScrub(sec: number): void
}

export function TimelineRuler({ durationSec, pxPerSec, onScrub }: TimelineRulerProps) {
  const step = niceTickSec(pxPerSec)
  const ticks: number[] = []
  for (let t = 0; t <= Math.max(durationSec, step); t += step) ticks.push(t)
  const width = secToPx(Math.max(durationSec, step), pxPerSec)

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
