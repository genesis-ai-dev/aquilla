import { describe, expect, it } from "vitest"
import { TIMELINE_SLICE_PX, timeSlices } from "./horizontal-slices"

describe("timeSlices", () => {
  it("tiles the canvas exactly, in the same pixel space as the ruler", () => {
    const pxPerSec = 38
    const canvas = 5000.5
    const slices = timeSlices(canvas, pxPerSec)
    expect(slices.length).toBe(Math.ceil(canvas / TIMELINE_SLICE_PX))
    expect(slices.reduce((sum, slice) => sum + slice.widthPx, 0)).toBe(canvas)
    expect(slices[0]).toMatchObject({ startPx: 0, startSec: 0, widthPx: TIMELINE_SLICE_PX })
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i].startPx).toBe(slices[i - 1].startPx + slices[i - 1].widthPx)
      expect(slices[i].startSec).toBeCloseTo(slices[i].startPx / pxPerSec)
      expect(slices[i].endSec).toBeCloseTo((slices[i].startPx + slices[i].widthPx) / pxPerSec)
    }
    const last = slices[slices.length - 1]
    expect(last.startPx + last.widthPx).toBe(canvas)
    expect(last.widthPx).toBeLessThanOrEqual(TIMELINE_SLICE_PX)
  })

  it("is empty when there is nothing to scroll", () => {
    expect(timeSlices(0, 38)).toEqual([])
    expect(timeSlices(Number.NaN, 38)).toEqual([])
  })
})
