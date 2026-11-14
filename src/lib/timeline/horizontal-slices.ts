// Fixed-width columns for the timeline's horizontal LegendList.
//
// The ruler, the playhead and every chip share one pixel coordinate: seconds
// times px-per-second, measured from the left of the canvas. A column is a
// slice of that same axis. Column i starts at i * slicePx, and the last column
// takes whatever width is left so the columns add up to the canvas exactly.
// A chip drawn at `left: sec * pxPerSec` inside a column shifted back by that
// column's start lands on the same pixel as the ruler tick for that second.

import { pxToSec } from "./scale"

/** One column of the horizontal list. The list holds every column and
 *  mounts the ones near the viewport. This only sets how wide each one is. */
export const TIMELINE_SLICE_PX = 2048

export interface TimeSlice {
  key: string
  startPx: number
  widthPx: number
  startSec: number
  endSec: number
}

export function timeSlices(
  canvasWidthPx: number,
  pxPerSec: number,
  slicePx = TIMELINE_SLICE_PX,
): TimeSlice[] {
  const width = Number.isFinite(canvasWidthPx) && canvasWidthPx > 0 ? canvasWidthPx : 0
  const pps = pxPerSec > 0 && Number.isFinite(pxPerSec) ? pxPerSec : 1
  const size = slicePx > 0 && Number.isFinite(slicePx) ? slicePx : TIMELINE_SLICE_PX
  if (width === 0) return []
  const count = Math.ceil(width / size)
  const out: TimeSlice[] = []
  for (let i = 0; i < count; i++) {
    const startPx = i * size
    const endPx = Math.min(width, startPx + size)
    out.push({
      key: String(i),
      startPx,
      widthPx: endPx - startPx,
      startSec: pxToSec(startPx, pps),
      endSec: pxToSec(endPx, pps),
    })
  }
  return out
}
