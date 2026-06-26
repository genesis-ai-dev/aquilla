import { describe, it, expect } from "vitest"
import { secToPx, pxToSec, clampRange, isVisible } from "./scale"

describe("scale", () => {
  it("converts seconds<->px round-trip", () => {
    expect(secToPx(4, 38)).toBe(152)
    expect(pxToSec(152, 38)).toBeCloseTo(4)
  })
  it("clampRange enforces min duration, non-negative start, finite", () => {
    expect(clampRange(5, 5.1, 0.3)).toEqual({ startSec: 5, endSec: 5.3 })
    expect(clampRange(-2, 1, 0.3)).toEqual({ startSec: 0, endSec: 1 })
    // invalid start resets to 0; a valid end past the min is kept as-is
    expect(clampRange(NaN, 1, 0.3)).toEqual({ startSec: 0, endSec: 1 })
    // invalid end falls back to start, then min duration applies
    expect(clampRange(5, NaN, 0.3)).toEqual({ startSec: 5, endSec: 5.3 })
  })
  it("isVisible is half-open intersection", () => {
    expect(isVisible(0, 3, 2, 8)).toBe(true)
    expect(isVisible(8, 9, 2, 8)).toBe(false) // touches end, excluded
    expect(isVisible(1, 2, 2, 8)).toBe(false) // ends at view start
  })
})
