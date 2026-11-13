import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render } from "@testing-library/react"
import { interpolatedSec, monotonicSec, MAX_EXTRAPOLATION_SEC, MAX_REGRESSION_SEC, TimelinePlayhead } from "./TimelinePlayhead"

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
    expect(headSec(container)).toBeCloseTo(3.917 + MAX_EXTRAPOLATION_SEC, 3)

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

  it("the run-ahead itself is unchanged: a playing head still runs up to the cap past a clock that stopped", () => {
    const { container } = render(<TimelinePlayhead currentSec={32} pxPerSec={PX} playing />)
    for (let t = 16; t <= 2000; t += 16) { now = t; runFrames() }
    expect(headSec(container)).toBeCloseTo(32 + MAX_EXTRAPOLATION_SEC, 3)
  })
})
