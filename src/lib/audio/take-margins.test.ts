import { describe, it, expect } from "vitest"

import { TAIL_KEEP_MS, takeTrims } from "./take-margins"

describe("takeTrims", () => {
  it("THE POINT: the window opens exactly on the cue's own start", () => {
    // The saver stores a negative lane offset (sample zero sits early); the head
    // trim undoes precisely that, so audible start = anchor + trim = the line.
    // If these two ever stop being inverses, takes go back to being drawn — and
    // flagged — as though they overlapped their neighbours.
    const lineStartMs = 10_000
    const targetOffsetMs = -350 // whatever the ring actually kept
    const { trimStartMs = 0 } = takeTrims({ targetOffsetMs, tailGraceMs: 250, durationMs: 3000 })
    const anchorMs = lineStartMs + targetOffsetMs
    expect(anchorMs + trimStartMs).toBe(lineStartMs)
  })

  it("holds for ANY kept head — the ring hands back whole buffers, not 200ms", () => {
    for (const targetOffsetMs of [-200, -277, -291, -350, -1]) {
      const { trimStartMs = 0 } = takeTrims({ targetOffsetMs, durationMs: 5000 })
      expect(trimStartMs).toBe(-targetOffsetMs)
    }
  })

  it("closes the window just past the end of the performance", () => {
    const t = takeTrims({ targetOffsetMs: -200, tailGraceMs: 250, durationMs: 3000 })
    expect(t.trimEndMs).toBe(3000 - (250 - TAIL_KEEP_MS))
  })

  it("nothing is trimmed when the recorder reports no margins (the webm path)", () => {
    expect(takeTrims({ durationMs: 3000 })).toEqual({})
  })

  it("a take anchored at or after its line has no head margin to window out", () => {
    expect(takeTrims({ targetOffsetMs: 0, durationMs: 3000 })).toEqual({})
    expect(takeTrims({ targetOffsetMs: 120, durationMs: 3000 })).toEqual({})
  })

  it("a take shorter than its own margins attaches untrimmed, never as a sliver", () => {
    expect(takeTrims({ targetOffsetMs: -200, tailGraceMs: 250, durationMs: 300 })).toEqual({})
  })

  it("an unknown or degenerate duration is left alone", () => {
    expect(takeTrims({ targetOffsetMs: -200, tailGraceMs: 250, durationMs: 0 })).toEqual({})
    expect(takeTrims({ targetOffsetMs: -200, tailGraceMs: 250, durationMs: NaN })).toEqual({})
  })
})
