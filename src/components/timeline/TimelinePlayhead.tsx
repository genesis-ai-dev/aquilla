// The master-clock cursor. A thin vertical line at the current time with a
// gently breathing handle. Purely presentational; pointer-transparent.

import { secToPx } from "@/lib/timeline/scale"

export interface TimelinePlayheadProps {
  currentSec: number
  pxPerSec: number
}

export function TimelinePlayhead({ currentSec, pxPerSec }: TimelinePlayheadProps) {
  return (
    <div
      data-testid="tl-playhead"
      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-red-500"
      style={{ left: `${secToPx(currentSec, pxPerSec)}px` }}
    >
      <span className="absolute -left-[5px] -top-px h-0 w-0 border-[5px] border-transparent border-t-red-500 motion-safe:animate-pulse" />
    </div>
  )
}
