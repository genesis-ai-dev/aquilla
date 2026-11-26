// AQU-2493 (review, Nov 9): a Station save holds the take where it sounds.
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { placeHoldingStart } from "./hold-place"

const cell = (att: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ id: "c", attachments: { a: { url: "u", type: "audio", ...att } }, ...over }) as unknown as CellData

describe("the saved version's place when the edit moved Start", () => {
  it("keeps the stored places, unset ones too, when Start did not move", () => {
    expect(placeHoldingStart(cell({ targetOffsetMs: 300 }), "a", 0, false)).toEqual({ targetOffsetMs: 300, recordingsOffsetMs: null })
  })

  it("moves the clip the other way following the source, and keeps the pause following the recordings", () => {
    const c = cell({ targetOffsetMs: 10_000, recordingsOffsetMs: 500, trimStartMs: 200 })
    expect(placeHoldingStart(c, "a", -200, false)).toEqual({ targetOffsetMs: 10_200, recordingsOffsetMs: 500 })
    expect(placeHoldingStart(c, "a", 2000, false)).toEqual({ targetOffsetMs: 8_000, recordingsOffsetMs: 500 })
  })

  it("on a layer moves the clip in both timings", () => {
    const c = cell({ targetOffsetMs: 10_000, recordingsOffsetMs: 500 })
    expect(placeHoldingStart(c, "a", -200, true)).toEqual({ targetOffsetMs: 10_200, recordingsOffsetMs: 700 })
  })

  it("a take with no place of its own following the recordings keeps the pause it read from the other one", () => {
    // Its pause was read from its place following the source (300 ms); that
    // place moves, so the pause is written down as it was.
    expect(placeHoldingStart(cell({ targetOffsetMs: 300 }), "a", -200, false)).toEqual({ targetOffsetMs: 500, recordingsOffsetMs: 300 })
  })

  it("a take on a line with no times (a book) keeps its pause from the start of its slot", () => {
    expect(placeHoldingStart(cell({}), "a", -200, false)).toEqual({ targetOffsetMs: 200, recordingsOffsetMs: 0 })
  })
})
