// AQU-1767 (Sam, 2026-10-14): a split take is transcribed whole, and only what
// its pieces keep is heard.
import { describe, expect, it } from "vitest"
import { keepSpans } from "./pcm-window"
import { splitTakeWindow } from "./transcribe"

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i)

describe("keepSpans", () => {
  it("joins the kept spans and maps a time in the joined audio back to the window", () => {
    // 10 samples a second: keep 0.0-0.3s and 0.6-0.9s of a 1s window.
    const { pcm, toWindowSec } = keepSpans(ramp(10), [{ startSec: 0.6, endSec: 0.9 }, { startSec: 0, endSec: 0.3 }], 10)
    expect(Array.from(pcm)).toEqual([0, 1, 2, 6, 7, 8])
    expect(toWindowSec(0.1)).toBeCloseTo(0.1)
    expect(toWindowSec(0.3)).toBeCloseTo(0.6)
    expect(toWindowSec(0.5)).toBeCloseTo(0.8)
  })

  it("merges overlapping spans, and leaves the audio alone when nothing is dropped", () => {
    const full = ramp(10)
    expect(keepSpans(full, [{ startSec: 0, endSec: 0.6 }, { startSec: 0.4, endSec: Infinity }], 10).pcm).toBe(full)
    expect(keepSpans(full, undefined, 10).pcm).toBe(full)
    expect(Array.from(keepSpans(full, [{ startSec: 0.2, endSec: 0.5 }, { startSec: 0.4, endSec: 0.7 }], 10).pcm)).toEqual([2, 3, 4, 5, 6])
  })
})

describe("splitTakeWindow", () => {
  it("runs from the first piece's start to the last piece's end, a piece with no end to the clip's", () => {
    expect(splitTakeWindow([{ trimStartMs: null, trimEndMs: 1500 }, { trimStartMs: 1500, trimEndMs: null }])).toEqual({
      trim: { trimStartMs: null, trimEndMs: null },
      keep: [{ startSec: 0, endSec: 1.5 }, { startSec: 1.5, endSec: Infinity }],
    })
  })
})
