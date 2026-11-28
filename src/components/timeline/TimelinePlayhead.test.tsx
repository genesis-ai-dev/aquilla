import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render } from "@testing-library/react"
import { followFrame, interpolatedSec, seekBoundSec, MAX_EXTRAPOLATION_SEC, MAX_REGRESSION_SEC, TimelinePlayhead } from "./TimelinePlayhead"

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

// AQU-2253 (browser pass, Nov 11: 5-g in Chromium): a line whose film never
// reports. The drawn head ran 0.45 s on past the clock (the run-ahead cap),
// then the spinner came with the same `currentSec`: React saw the same `left`
// it had rendered and wrote nothing, so the head stayed 0.45 s into the line
// while the component's floor went back to the clock. When the queue's own
// clock took over from the line's start, the head was drawn 0.45 s backward
// in the middle of playback. A waiting head follows the clock exactly, as the
// rule above says, so the run carries on forward from where it waited.
describe("a head that has run ahead of a clock that stopped", () => {
  const PX = 100
  let now = 0
  let frames: FrameRequestCallback[] = []
  const runFrames = () => {
    const due = frames
    frames = []
    for (const f of due) f(now)
  }
  const headSec = (c: HTMLElement) => parseFloat((c.querySelector('[data-testid="tl-playhead"]') as HTMLElement).style.left) / PX

  beforeEach(() => {
    now = 0
    frames = []
    vi.spyOn(performance, "now").mockImplementation(() => now)
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { frames.push(f); return frames.length })
    vi.stubGlobal("cancelAnimationFrame", () => { frames = [] })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("goes back to the clock while it waits, though the clock's second did not change, and then only moves forward", () => {
    const { container, rerender } = render(<TimelinePlayhead currentSec={3.917} pxPerSec={PX} playing />)
    for (let t = 16; t <= 1200; t += 16) { now = t; runFrames() }
    // Ran on past the clock (`followFrame` parks a little past the cap).
    expect(headSec(container)).toBeGreaterThan(3.917 + MAX_EXTRAPOLATION_SEC - 0.01)

    rerender(<TimelinePlayhead currentSec={3.917} pxPerSec={PX} playing={false} />)
    expect(headSec(container)).toBeCloseTo(3.917, 3)

    now = 3200
    rerender(<TimelinePlayhead currentSec={3.917} pxPerSec={PX} playing />)
    let last = headSec(container)
    expect(last).toBeCloseTo(3.917, 3)
    for (let t = 3216; t <= 3600; t += 16) {
      now = t
      runFrames()
      const sec = headSec(container)
      expect(sec).toBeGreaterThanOrEqual(last)
      last = sec
    }
  })

  // Merged onto dev's `followFrame` (Nov 14): the head coasts and eases, so
  // it parks a little past the cap rather than on it. What matters here is
  // that it runs on, and then holds.
  it("the run-ahead itself is unchanged: a playing head still runs on past a clock that stopped, then holds", () => {
    const { container } = render(<TimelinePlayhead currentSec={32} pxPerSec={PX} playing />)
    for (let t = 16; t <= 2000; t += 16) { now = t; runFrames() }
    const parked = headSec(container)
    expect(parked).toBeGreaterThan(32 + MAX_EXTRAPOLATION_SEC - 0.01)
    expect(parked).toBeLessThan(32 + 1)
    for (let t = 2016; t <= 3000; t += 16) { now = t; runFrames() }
    expect(headSec(container)).toBeCloseTo(parked, 3)
  })
})
