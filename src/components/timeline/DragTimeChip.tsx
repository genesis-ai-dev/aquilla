// The floating time readout above a chip mid-drag: exactly the value release
// would commit, anchored to the edge being manipulated. Born on the timeline
// cards (SUB-11); extracted 2026-08-21 (Matt's QA) so the dub-take lane —
// whose drags showed nothing at all — says the same thing the same way.

import { cn } from "@/lib/utils"
import { fmtDragTime } from "./format"

export function DragTimeChip({
  mode,
  startSec,
  endSec,
  deltaSec,
}: {
  /** Which edge is being manipulated. A move reads out the whole span (both
   *  edges are travelling); a resize reads out only the moving edge — the
   *  still one would be noise. Also picks the anchor side, so the bubble
   *  rides the edge under the pointer. */
  mode: "move" | "resize-l" | "resize-r"
  startSec: number
  endSec: number
  /** How far from where it was — the mid-drag question is usually "how much
   *  did I move this?", not "where is it now". */
  deltaSec: number
}) {
  return (
    <span
      data-testid="tl-drag-chip"
      className={cn(
        "pointer-events-none absolute -top-6 z-30 rounded bg-foreground px-1.5 py-0.5 font-mono text-[10px] tabular-nums whitespace-nowrap text-background shadow",
        mode === "resize-r" ? "right-0" : "left-0",
      )}
    >
      {mode === "move"
        ? `${fmtDragTime(startSec)}–${fmtDragTime(endSec)}`
        : fmtDragTime(mode === "resize-l" ? startSec : endSec)}
      {" "}({deltaSec >= 0 ? "+" : "−"}{Math.abs(deltaSec).toFixed(2)}s)
    </span>
  )
}
