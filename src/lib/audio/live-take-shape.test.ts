import { describe, it, expect } from "vitest"
import { columnPeaks, liveSpanSec } from "./live-take-shape"

describe("liveSpanSec", () => {
  it("spans the target bar's own axis, so the edge and the bar move together", () => {
    expect(liveSpanSec(1, 2.5, 1.5, 8)).toBe(4)
  })
  it("widens to hold the whole take once it runs past", () => {
    expect(liveSpanSec(5.2, 2.5, 1.5, 8)).toBe(5.2)
  })
  it("uses the fallback span on a line with no target", () => {
    expect(liveSpanSec(3, null, 1.5, 8)).toBe(8)
    expect(liveSpanSec(9, null, 1.5, 8)).toBe(9)
  })
  it("a zero-length target is still the bar's axis (target + headroom)", () => {
    expect(liveSpanSec(0.5, 0, 1.5, 8)).toBe(1.5)
  })
})

describe("columnPeaks", () => {
  it("keeps each column's LOUDEST frame, not an average", () => {
    // Four columns of 1s; frames at 0.1/0.5 (col 0) and 1.2/1.8 (col 1).
    const out = columnPeaks([0.1, 0.5, 1.2, 1.8], [0.2, 0.9, 0.4, 0.1], 4, 4, 4)
    expect(out[0]).toBeCloseTo(0.9)
    expect(out[1]).toBeCloseTo(0.4)
  })
  it("a column no frame landed in holds the frame before it", () => {
    // 8 columns over 2s = 0.25s each; frames only at 0.1 and 0.9.
    const out = columnPeaks([0.1, 0.9], [0.5, 0.3], 2, 2, 8)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(0.5) // held
    expect(out[3]).toBeCloseTo(0.3)
    expect(out[5]).toBeCloseTo(0.3) // past the last frame: held (never drawn)
  })
  it("reads only the first n frames", () => {
    const out = columnPeaks([0.1, 0.2], [0.4, 1], 1, 1, 1)
    expect(out[0]).toBeCloseTo(0.4)
  })
})
