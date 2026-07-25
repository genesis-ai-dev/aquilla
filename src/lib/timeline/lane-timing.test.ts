// AQU-646 round 6: per-lane timing resolution — the pure core behind the
// frozen source row, independent subtitle spans, and honest target chips.

import { describe, expect, it } from "vitest"
import {
  chipOverflowState,
  effectiveAttachmentDurationMs,
  subtitleSpanSec,
  targetChipSpanSec,
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

describe("targetChipSpanSec", () => {
  it("default position with a known duration", () => {
    expect(targetChipSpanSec(cell({}), { durationMs: 4000 })).toEqual({ start: 10, end: 14, usingFallback: false })
  })
  it("moved chip (target_start_ms) keeps the recording's length", () => {
    expect(
      targetChipSpanSec(cell({ metadata: { target_start_ms: 12000 } }), { durationMs: 4000 }),
    ).toEqual({ start: 12, end: 16, usingFallback: false })
  })
  it("unknown duration falls back to the section width, flagged", () => {
    expect(targetChipSpanSec(cell({}), undefined)).toEqual({ start: 10, end: 20, usingFallback: true })
  })
  it("null without section timing", () => {
    expect(targetChipSpanSec(cell({ startTime: undefined }), { durationMs: 1000 })).toBeNull()
  })
})

describe("targetDueSec", () => {
  it("defaults to the section start", () => {
    expect(targetDueSec(cell({}))).toBe(10)
  })
  it("honors target_start_ms", () => {
    expect(targetDueSec(cell({ metadata: { target_start_ms: 13250 } }))).toBe(13.25)
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
  it("reaching the next chip → cutoff, even when the next chip starts late", () => {
    expect(chipOverflowState(24, 20, 23)).toBe("cutoff")
    // Not yet touching the next chip → still just soft.
    expect(chipOverflowState(22, 20, 23)).toBe("soft")
  })
})
