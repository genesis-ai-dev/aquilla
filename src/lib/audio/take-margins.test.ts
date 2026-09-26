import { describe, it, expect } from "vitest"

import { TAIL_KEEP_MS, composeTakeWindow, defaultTakeWindow, takeTrims } from "./take-margins"

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

describe("defaultTakeWindow (AQU-1210)", () => {
  it("is what Save has always stored for a WAV take", () => {
    expect(defaultTakeWindow({ cue: { startTime: 10 }, preRollMs: 200, tailGraceMs: 250, durationMs: 3600 }))
      .toEqual({ laneOffsetMs: -200, trimStartMs: 200, trimEndMs: 3600 - (250 - TAIL_KEEP_MS) })
  })

  it("carries no window and no retime for a compressed take", () => {
    expect(defaultTakeWindow({ cue: { startTime: 10 }, durationMs: 3600 })).toEqual({ laneOffsetMs: null })
  })

  it("clamps the anchor at file zero for a cue at the very start", () => {
    const w = defaultTakeWindow({ cue: { startTime: 0.1 }, preRollMs: 200, tailGraceMs: 250, durationMs: 3600 })
    expect(w.laneOffsetMs).toBe(-100)
    expect(w.trimStartMs).toBe(100)
  })

  it("never retimes an untimed line", () => {
    expect(defaultTakeWindow({ cue: {}, preRollMs: 200, tailGraceMs: 250, durationMs: 3600 }).laneOffsetMs).toBeNull()
  })
})

describe("composeTakeWindow (AQU-1210)", () => {
  const cue = { startTime: 10 }
  const defaults = defaultTakeWindow({ cue, preRollMs: 200, tailGraceMs: 250, durationMs: 3600 })

  it("an untouched window is exactly the default", () => {
    expect(composeTakeWindow({ cue, defaults, operator: null, durationMs: 3600 })).toBe(defaults)
  })

  it("a head trim past the silence pulls the first kept sample onto the cue", () => {
    const w = composeTakeWindow({ cue, defaults, operator: { startMs: 700, endMs: 3360 }, durationMs: 3600 })
    // audible start = anchor + head trim = (10000 - 700) + 700 = the cue's start
    expect(w).toEqual({ laneOffsetMs: -700, trimStartMs: 700, trimEndMs: 3360 })
  })

  it("a tail trim closes the window without moving the take", () => {
    const w = composeTakeWindow({ cue, defaults, operator: { startMs: 200, endMs: 2500 }, durationMs: 3600 })
    expect(w).toEqual({ laneOffsetMs: -200, trimStartMs: 200, trimEndMs: 2500 })
  })

  it("a compressed take trimmed at its head gains a retime; at its tail alone, none", () => {
    const plain = defaultTakeWindow({ cue, durationMs: 3600 })
    expect(composeTakeWindow({ cue, defaults: plain, operator: { startMs: 400, endMs: null }, durationMs: 3600 }))
      .toEqual({ laneOffsetMs: -400, trimStartMs: 400 })
    expect(composeTakeWindow({ cue, defaults: plain, operator: { startMs: null, endMs: 3000 }, durationMs: 3600 }))
      .toEqual({ laneOffsetMs: null, trimEndMs: 3000 })
  })

  it("dragging a line back to the clip's edge clears that side", () => {
    const w = composeTakeWindow({ cue, defaults, operator: { startMs: null, endMs: null }, durationMs: 3600 })
    expect(w).toEqual({ laneOffsetMs: 0 })
  })

  it("an untimed line keeps its trim but is never retimed", () => {
    const w = composeTakeWindow({ cue: {}, defaults: { laneOffsetMs: null }, operator: { startMs: 500, endMs: null }, durationMs: 3600 })
    expect(w).toEqual({ laneOffsetMs: null, trimStartMs: 500 })
  })
})
