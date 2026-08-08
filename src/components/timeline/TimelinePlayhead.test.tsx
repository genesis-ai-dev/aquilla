import { describe, it, expect } from "vitest"
import { interpolatedSec, monotonicSec, MAX_EXTRAPOLATION_SEC, MAX_REGRESSION_SEC } from "./TimelinePlayhead"

describe("interpolatedSec", () => {
  it("advances with wall time, scaled by rate", () => {
    expect(interpolatedSec(10, 1000, 1100, 1)).toBeCloseTo(10.1, 5)
    expect(interpolatedSec(10, 1000, 1100, 2)).toBeCloseTo(10.2, 5)
  })

  it("parks at the extrapolation cap when the clock stops ticking", () => {
    expect(interpolatedSec(10, 1000, 9000, 1)).toBeCloseTo(10 + MAX_EXTRAPOLATION_SEC, 5)
  })
})

// 2026-08-08 (bounce forensics): every verse boundary used to paint a ~90ms
// backward snap when the first real anchor landed behind the optimistic
// handoff. The clamp renders those as a hold, never backward motion.
describe("monotonicSec", () => {
  it("forward motion always passes", () => {
    expect(monotonicSec(10, 10.2, true)).toBe(10.2)
  })

  it("a small regression HOLDS at the last painted position while playing", () => {
    expect(monotonicSec(10.2, 10.11, true)).toBe(10.2) // the measured ~90ms case
    expect(monotonicSec(10.2, 10.2 - MAX_REGRESSION_SEC + 0.01, true)).toBe(10.2)
  })

  it("a genuine backward seek (large regression) passes through", () => {
    expect(monotonicSec(10.2, 10.2 - MAX_REGRESSION_SEC, true)).toBe(10.2 - MAX_REGRESSION_SEC)
    expect(monotonicSec(60, 5, true)).toBe(5)
  })

  it("the pass-through bound scales with playback rate (review finding)", () => {
    // At 2x the extrapolation cap is 0.9s — a stall-then-resume regression of
    // ~0.9s is still overshoot, not a seek, and must HOLD.
    expect(monotonicSec(10.9, 10.05, true, 2)).toBe(10.9)
    // Beyond the scaled bound it is a genuine backward seek.
    expect(monotonicSec(10.9, 9.9, true, 2)).toBe(9.9)
    // At 1x the bound stays MAX_REGRESSION_SEC.
    expect(monotonicSec(10.9, 10.35, true, 1)).toBe(10.35)
  })

  it("paused rendering follows the clock exactly — even backwards", () => {
    expect(monotonicSec(10.2, 10.11, false)).toBe(10.11)
    expect(monotonicSec(null, 3, true)).toBe(3)
  })
})
