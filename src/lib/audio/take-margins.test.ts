import { describe, it, expect } from "vitest"

import { HEAD_KEEP_MS, TAIL_KEEP_MS, takeMarginTrims } from "./take-margins"

describe("takeMarginTrims", () => {
  it("windows out the machine-added margin, keeping a sliver of runway at each end", () => {
    // A normal take: 200ms pre-roll, 250ms stop-grace, 3s of clip.
    const t = takeMarginTrims({ preRollMs: 200, tailGraceMs: 250, durationMs: 3000 })
    expect(t.trimStartMs).toBe(200 - HEAD_KEEP_MS)
    expect(t.trimEndMs).toBe(3000 - (250 - TAIL_KEEP_MS))
  })

  it("THE POINT: the window opens exactly HEAD_KEEP_MS before the line", () => {
    // The saver anchors sample zero preRollMs before the line, so the audible
    // start is anchor + trimStart. If these two ever stop composing, takes go
    // back to being drawn (and flagged) as though they overlapped.
    const preRollMs = 200
    const lineStartMs = 10_000
    const { trimStartMs = 0 } = takeMarginTrims({ preRollMs, tailGraceMs: 250, durationMs: 3000 })
    const anchorMs = lineStartMs - preRollMs
    expect(anchorMs + trimStartMs).toBe(lineStartMs - HEAD_KEEP_MS)
  })

  it("nothing is trimmed when the recorder reports no margins (the webm path)", () => {
    expect(takeMarginTrims({ durationMs: 3000 })).toEqual({})
  })

  it("a pre-roll shorter than the keep is all runway already", () => {
    const t = takeMarginTrims({ preRollMs: HEAD_KEEP_MS - 5, tailGraceMs: 0, durationMs: 3000 })
    expect(t).toEqual({})
  })

  it("a take shorter than its own margins attaches untrimmed, never as a sliver", () => {
    // Stop pressed almost immediately: the arithmetic would leave ~50ms.
    expect(takeMarginTrims({ preRollMs: 200, tailGraceMs: 250, durationMs: 300 })).toEqual({})
  })

  it("an unknown or degenerate duration is left alone", () => {
    expect(takeMarginTrims({ preRollMs: 200, tailGraceMs: 250, durationMs: 0 })).toEqual({})
    expect(takeMarginTrims({ preRollMs: 200, tailGraceMs: 250, durationMs: NaN })).toEqual({})
  })
})
