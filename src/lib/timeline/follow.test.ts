// AQU-646: follow-playhead page-flip math.

import { describe, expect, it } from "vitest"
import { computeFollowScroll } from "./follow"

describe("computeFollowScroll", () => {
  const VIEW = 1000
  const TRACK = 10_000

  it("no scroll while the playhead is inside the comfortable zone", () => {
    expect(computeFollowScroll(0, 0, VIEW, TRACK)).toBeNull()
    expect(computeFollowScroll(500, 0, VIEW, TRACK)).toBeNull()
    expect(computeFollowScroll(849, 0, VIEW, TRACK)).toBeNull()
  })

  it("flips when the playhead crosses 85% of the viewport, landing it at 10%", () => {
    const target = computeFollowScroll(850, 0, VIEW, TRACK)
    expect(target).toBe(850 - VIEW * 0.1)
  })

  it("flips back when the playhead is off-screen LEFT (backwards seek)", () => {
    const target = computeFollowScroll(200, 2_000, VIEW, TRACK)
    expect(target).toBe(100) // 200 − 10% of viewport
  })

  it("clamps to the scrollable range at the track end", () => {
    const target = computeFollowScroll(9_990, 8_000, VIEW, TRACK)
    expect(target).toBe(TRACK - VIEW)
  })

  it("clamps to zero near the track start", () => {
    expect(computeFollowScroll(50, 2_000, VIEW, TRACK)).toBe(0)
  })

  it("no-ops with an unmeasured viewport", () => {
    expect(computeFollowScroll(850, 0, 0, TRACK)).toBeNull()
  })

  it("returns null when already at the target (no scroll churn)", () => {
    expect(computeFollowScroll(850, 750, VIEW, TRACK)).toBeNull()
  })
})

// Playhead interpolation math (the rAF loop itself isn't testable).
import { interpolatedSec } from "@/components/timeline/TimelinePlayhead"

describe("interpolatedSec", () => {
  it("advances linearly from the anchor at the playback rate", () => {
    expect(interpolatedSec(10, 1_000, 1_500, 1)).toBeCloseTo(10.5)
    expect(interpolatedSec(10, 1_000, 1_500, 2)).toBeCloseTo(11)
    expect(interpolatedSec(10, 1_000, 1_000, 1)).toBe(10)
  })
})
