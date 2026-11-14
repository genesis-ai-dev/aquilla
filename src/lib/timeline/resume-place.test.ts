import { describe, expect, it } from "vitest"
import { cellIdNearestStart, resumeScrollLeft } from "./resume-place"

const starts = [
  { id: "gen-1", startSec: 0 },
  { id: "gen-22", startSec: 4000 },
  { id: "gen-50", startSec: 9000 },
]

describe("cellIdNearestStart", () => {
  it("returns the line that has started under the middle of the view", () => {
    expect(cellIdNearestStart(starts, 4100)).toBe("gen-22")
    expect(cellIdNearestStart(starts, 9000)).toBe("gen-50")
  })

  it("treats the start of the file as the first line", () => {
    expect(cellIdNearestStart(starts, 0)).toBe("gen-1")
    expect(cellIdNearestStart(starts, -5)).toBe("gen-1")
  })

  it("returns null when there is nothing to return to", () => {
    expect(cellIdNearestStart([], 10)).toBeNull()
    expect(cellIdNearestStart(starts, Number.NaN)).toBeNull()
  })
})

describe("resumeScrollLeft", () => {
  it("leaves a line the reload already has on screen, and keeps that spot when its clock moves", () => {
    const kept = resumeScrollLeft({ atPx: 9000, scrollLeft: 9000, viewportPx: 800, heldOffsetPx: null })
    expect(kept).toEqual({ left: 9000, offsetPx: 0, move: false })
    // The programme grew; the line stays at the left edge instead of sliding back.
    const followed = resumeScrollLeft({ atPx: 12000, scrollLeft: 9000, viewportPx: 800, heldOffsetPx: kept.offsetPx })
    expect(followed).toEqual({ left: 12000, offsetPx: 0, move: true })
  })

  it("centers a line the reload did not already show", () => {
    expect(resumeScrollLeft({ atPx: 9000, scrollLeft: 0, viewportPx: 800, heldOffsetPx: null }))
      .toEqual({ left: 8600, offsetPx: 400, move: true })
  })
})
