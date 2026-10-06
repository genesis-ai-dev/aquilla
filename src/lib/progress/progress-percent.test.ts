// AQU-1493: no progress figure rounds outstanding work up to 100%.
import { describe, it, expect } from "vitest"
import { progressPercent, progressPercentOfFraction } from "./progress-percent"

describe("progressPercent", () => {
  it("never reads 100 while anything is outstanding", () => {
    // Genesis-sized: six short is 99.5%, which plain rounding calls 100.
    expect(progressPercent(1194, 1200)).toBe(99)
    expect(progressPercent(1199, 1200)).toBe(99)
    expect(progressPercent(199, 200)).toBe(99)
  })

  it("reads 100 when the part is the whole, or outruns it", () => {
    expect(progressPercent(1200, 1200)).toBe(100)
    expect(progressPercent(112, 100)).toBe(100)
  })

  it("rounds as before everywhere else, and is 0 with nothing to measure", () => {
    expect(progressPercent(72, 100)).toBe(72)
    expect(progressPercent(2, 3)).toBe(67)
    expect(progressPercent(0, 40)).toBe(0)
    expect(progressPercent(0, 0)).toBe(0)
    expect(progressPercent(5, 0)).toBe(0)
    expect(progressPercent(Number.NaN, 10)).toBe(0)
  })
})

describe("progressPercentOfFraction", () => {
  it("never reads 100 below exactly 1", () => {
    expect(progressPercentOfFraction(1194 / 1200)).toBe(99)
    expect(progressPercentOfFraction(0.9999)).toBe(99)
  })

  it("reads 100 at 1, and for an average of projects that are all complete", () => {
    expect(progressPercentOfFraction(1)).toBe(100)
    const all = [1, 1, 1]
    expect(progressPercentOfFraction(all.reduce((a, b) => a + b, 0) / all.length)).toBe(100)
    const one = [1, 1, 1199 / 1200]
    expect(progressPercentOfFraction(one.reduce((a, b) => a + b, 0) / one.length)).toBe(99)
  })

  it("is 0 for nothing, a negative or a missing count", () => {
    expect(progressPercentOfFraction(0)).toBe(0)
    expect(progressPercentOfFraction(-0.2)).toBe(0)
    expect(progressPercentOfFraction(Number.NaN)).toBe(0)
    expect(progressPercentOfFraction(0.724)).toBe(72)
  })
})
