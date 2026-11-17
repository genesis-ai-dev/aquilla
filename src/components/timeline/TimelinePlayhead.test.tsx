import { describe, it, expect } from "vitest"
import { followFrame, interpolatedSec, seekBoundSec, MAX_EXTRAPOLATION_SEC, MAX_REGRESSION_SEC } from "./TimelinePlayhead"

describe("interpolatedSec", () => {
  it("advances with wall time, scaled by rate", () => {
    expect(interpolatedSec(10, 1000, 1100, 1)).toBeCloseTo(10.1, 5)
    expect(interpolatedSec(10, 1000, 1100, 2)).toBeCloseTo(10.2, 5)
  })

  it("parks at the extrapolation cap when the clock stops ticking", () => {
    expect(interpolatedSec(10, 1000, 9000, 1)).toBeCloseTo(10 + MAX_EXTRAPOLATION_SEC, 5)
  })
})

describe("followFrame", () => {
  it("keeps moving through ticks that arrive late by differing amounts", () => {
    // 60fps; the clock ticks every 250ms and each tick reaches the head 10 to
    // 45ms after the element sampled it — one or two effects behind, varying
    // from tick to tick as it does in the app.
    const frameMs = 1000 / 60
    const lateMs = [10, 45, 20, 40]
    let head = { sec: 0, at: 0 }
    let clock = { sec: 0, at: 0 }
    let stopped = 0
    for (let now = frameMs; now < 3000; now += frameMs) {
      const tick = Math.floor(now / 250)
      const late = lateMs[tick % lateMs.length]
      const due = tick * 250
      if (due > 0 && now >= due + late && clock.sec !== due / 1000) clock = { sec: due / 1000, at: now }
      const next = followFrame(head, clock.sec, clock.at, now, 1)
      expect(next.sec).toBeGreaterThanOrEqual(head.sec)
      if (now > 300 && next.sec === head.sec) stopped++
      head = next
    }
    expect(stopped).toBe(0)
    expect(head.sec).toBeCloseTo(3, 1)
  })

  // 2026-08-08 (bounce forensics): a correction never paints backward motion
  // while playing; a gap of a seek's size, scaled by rate, is a seek.
  it.each([
    { name: "a small regression holds", head: 10.2, clock: 10.11, rate: 1, want: 10.2 },
    { name: "a backward seek jumps", head: 60, clock: 5, rate: 1, want: 5 },
    { name: "a forward seek jumps", head: 5, clock: 60, rate: 1, want: 60 },
    { name: "at 2x a 0.85s regression is still overshoot", head: 10.9, clock: 10.05, rate: 2, want: 10.9 },
    { name: "at 2x a 1s regression is a seek", head: 10.9, clock: 9.9, rate: 2, want: 9.9 },
  ])("$name", ({ head, clock, rate, want }) => {
    expect(followFrame({ sec: head, at: 1000 }, clock, 1000, 1000, rate).sec).toBeCloseTo(want, 5)
  })

  it("the seek bound covers the worst extrapolation overshoot", () => {
    expect(seekBoundSec(1)).toBe(MAX_REGRESSION_SEC)
    expect(seekBoundSec(2)).toBeGreaterThan(MAX_EXTRAPOLATION_SEC * 2)
  })
})
