// AQU-646 round 6: per-lane timing resolution — the pure core behind the
// frozen source row, independent subtitle spans, and honest target chips.

import { describe, expect, it } from "vitest"
import {
  chipOverflowState,
  effectiveAttachmentDurationMs,
  subtitleSpanSec,
  targetChipGeom,
  targetDueSec,
} from "./lane-timing"
import type { CellData } from "@/hooks/useCells"

const cell = (over: Partial<CellData>): CellData =>
  ({
    id: "c1", fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media", startTime: 10, endTime: 20,
    ...over,
  }) as CellData

describe("effectiveAttachmentDurationMs", () => {
  it("plain duration", () => {
    expect(effectiveAttachmentDurationMs({ durationMs: 4200 })).toBe(4200)
  })
  it("trim-aware", () => {
    expect(effectiveAttachmentDurationMs({ durationMs: 9000, trimStartMs: 1000, trimEndMs: 5000 })).toBe(4000)
  })
  it("trimEnd alone bounds the length", () => {
    expect(effectiveAttachmentDurationMs({ durationMs: null as unknown as number, trimEndMs: 3000 })).toBe(3000)
  })
  it("null when unknown or degenerate", () => {
    expect(effectiveAttachmentDurationMs(undefined)).toBeNull()
    expect(effectiveAttachmentDurationMs({})).toBeNull()
    expect(effectiveAttachmentDurationMs({ durationMs: 1000, trimStartMs: 2000 })).toBeNull()
  })
})

describe("subtitleSpanSec", () => {
  it("media cell without override → the source split (the seed)", () => {
    expect(subtitleSpanSec(cell({}))).toEqual({ start: 10, end: 20 })
  })
  it("media cell with override → the independent span", () => {
    expect(
      subtitleSpanSec(cell({ metadata: { subtitle_start_ms: 11500, subtitle_end_ms: 21500 } })),
    ).toEqual({ start: 11.5, end: 21.5 })
  })
  it("TEXT cell ignores subtitle metadata — its own timing IS subtitle timing", () => {
    expect(
      subtitleSpanSec(cell({ medium: "text", metadata: { subtitle_start_ms: 99000, subtitle_end_ms: 100000 } })),
    ).toEqual({ start: 10, end: 20 })
  })
  it("corrupt override (end <= start, non-number) falls back to the source split", () => {
    expect(subtitleSpanSec(cell({ metadata: { subtitle_start_ms: 5000, subtitle_end_ms: 5000 } }))).toEqual({ start: 10, end: 20 })
    expect(subtitleSpanSec(cell({ metadata: { subtitle_start_ms: "x", subtitle_end_ms: 9000 } }))).toEqual({ start: 10, end: 20 })
  })
  it("null when the cell has no timing at all", () => {
    expect(subtitleSpanSec(cell({ startTime: undefined, endTime: undefined }))).toBeNull()
  })
})

describe("targetChipGeom — clip-zero anchored (round 7)", () => {
  it("default position with a known duration", () => {
    expect(targetChipGeom(cell({}), { durationMs: 4000 })).toEqual({
      anchor: 10, start: 10, end: 14,
      trimStartSec: 0, trimEndSec: null, durationSec: 4, usingFallback: false,
    })
  })
  it("moved chip (target_start_ms) keeps the recording's length", () => {
    const g = targetChipGeom(cell({ metadata: { target_start_ms: 12000 } }), { durationMs: 4000 })
    expect(g).toMatchObject({ anchor: 12, start: 12, end: 16 })
  })
  it("a HEAD trim moves only the left edge — the remaining audio stays put", () => {
    const g = targetChipGeom(cell({}), { durationMs: 4000, trimStartMs: 1500 })
    expect(g).toMatchObject({ anchor: 10, start: 11.5, end: 14, trimStartSec: 1.5 })
  })
  it("a TAIL trim moves only the right edge", () => {
    const g = targetChipGeom(cell({}), { durationMs: 4000, trimEndMs: 3000 })
    expect(g).toMatchObject({ anchor: 10, start: 10, end: 13, trimEndSec: 3 })
  })
  it("head + tail trims compose; moving preserves the trimmed length", () => {
    const g = targetChipGeom(
      cell({ metadata: { target_start_ms: 12000 } }),
      { durationMs: 4000, trimStartMs: 1000, trimEndMs: 3500 },
    )
    expect(g).toMatchObject({ anchor: 12, start: 13, end: 15.5 })
  })
  it("unknown duration falls back to the section width, flagged", () => {
    const g = targetChipGeom(cell({}), undefined)
    expect(g).toMatchObject({ start: 10, end: 20, usingFallback: true, durationSec: null })
  })
  it("null without section timing", () => {
    expect(targetChipGeom(cell({ startTime: undefined }), { durationMs: 1000 })).toBeNull()
  })
})

describe("targetDueSec — trim-aware (round 7)", () => {
  it("defaults to the section start", () => {
    expect(targetDueSec(cell({}))).toBe(10)
  })
  it("honors target_start_ms", () => {
    expect(targetDueSec(cell({ metadata: { target_start_ms: 13250 } }))).toBe(13.25)
  })
  it("a head-trimmed dub is due at its AUDIBLE start", () => {
    expect(
      targetDueSec(cell({ metadata: { target_start_ms: 12000 } }), { durationMs: 4000, trimStartMs: 500 }),
    ).toBe(12.5)
  })
})

describe("chipOverflowState", () => {
  it("inside the section → none", () => {
    expect(chipOverflowState(19, 20, null)).toBe("none")
  })
  it("slightly past the end (within tolerance) → none", () => {
    expect(chipOverflowState(20.3, 20, null)).toBe("none")
  })
  it("meaningfully past → soft", () => {
    expect(chipOverflowState(21, 20, null)).toBe("soft")
  })
  it("reaching the next chip → overlap (both will sound), even when the next chip starts late", () => {
    expect(chipOverflowState(24, 20, 23)).toBe("overlap")
    // Not yet touching the next chip → still just soft.
    expect(chipOverflowState(22, 20, 23)).toBe("soft")
  })
})
