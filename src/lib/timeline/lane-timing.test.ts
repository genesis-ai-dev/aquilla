// AQU-646 round 6: per-lane timing resolution — the pure core behind the
// frozen source row, independent subtitle spans, and honest target chips.

import { describe, expect, it } from "vitest"
import {
  chipOverflowState,
  chipOverlaps,
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
  // Section 15–20 throughout; the chip span varies.
  const section = { start: 15, end: 20 }
  it("inside the section → none", () => {
    expect(chipOverflowState({ start: 15, end: 19 }, section, null, null)).toBe("none")
  })
  it("slightly past the end (within tolerance) → none", () => {
    expect(chipOverflowState({ start: 15, end: 20.3 }, section, null, null)).toBe("none")
  })
  it("meaningfully past → soft", () => {
    expect(chipOverflowState({ start: 15, end: 21 }, section, null, null)).toBe("soft")
  })
  it("reaching the next chip → overlap (both will sound), even when the next chip starts late", () => {
    expect(chipOverflowState({ start: 15, end: 24 }, section, null, 23)).toBe("overlap")
    // Not yet touching the next chip → still just soft.
    expect(chipOverflowState({ start: 15, end: 22 }, section, null, 23)).toBe("soft")
  })
  it("BLAME THE TRESPASSER: an in-bounds chip stays 'none' when the NEXT chip slid back under its tail", () => {
    // Next chip (section 20–25) dragged back to start at 18 — under this
    // chip's in-bounds tail. The mover carries the warning, not this chip.
    expect(chipOverflowState({ start: 15, end: 19.5 }, section, null, 18)).toBe("none")
  })
  it("a chip whose HEAD reaches back under the previous chip goes red", () => {
    // This chip's section is 20–25; it slid back to 18, under prev's tail.
    expect(
      chipOverflowState({ start: 18, end: 23 }, { start: 20, end: 25 }, { start: 15, end: 19.5 }, null),
    ).toBe("overlap")
  })
  it("a backward slide into EMPTY slack (prev chip short) is not an overlap", () => {
    expect(
      chipOverflowState({ start: 18, end: 23 }, { start: 20, end: 25 }, { start: 15, end: 17.5 }, null),
    ).toBe("none")
  })
  it("a chip slid entirely BEFORE the previous chip's box does not intersect it", () => {
    expect(
      chipOverflowState({ start: 10, end: 12 }, { start: 20, end: 25 }, { start: 15, end: 19 }, null),
    ).toBe("none")
  })
  it("amber is unaffected by an innocent neighbourly overlap on the head side", () => {
    // Runs long past its own section but doesn't reach the next chip; the
    // previous chip's tail under our in-bounds head changes nothing.
    expect(
      chipOverflowState({ start: 20, end: 25.6 }, { start: 20, end: 25 }, { start: 15, end: 20.4 }, 26),
    ).toBe("soft")
  })
})

describe("chipOverlaps", () => {
  it("tail = how far the end intrudes past the next chip's start", () => {
    expect(chipOverlaps({ start: 15, end: 24 }, null, 23)).toEqual({ headSec: null, tailSec: 1 })
  })
  it("head = the stretch of this chip under the previous chip's tail", () => {
    expect(chipOverlaps({ start: 18, end: 23 }, { start: 15, end: 19.5 }, null)).toEqual({
      headSec: 1.5,
      tailSec: null,
    })
  })
  it("head is bounded by this chip's own end", () => {
    expect(chipOverlaps({ start: 18, end: 19 }, { start: 15, end: 22 }, null)).toEqual({
      headSec: 1,
      tailSec: null,
    })
  })
  it("no intersection → no head overlap", () => {
    expect(chipOverlaps({ start: 10, end: 12 }, { start: 15, end: 19 }, null)).toEqual({
      headSec: null,
      tailSec: null,
    })
  })
  it("both sides can overlap at once", () => {
    expect(chipOverlaps({ start: 18, end: 26 }, { start: 15, end: 19 }, 25)).toEqual({
      headSec: 1,
      tailSec: 1,
    })
  })
})
