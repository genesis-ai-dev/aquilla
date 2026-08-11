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
  targetOffsetMsFor,
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

describe("targetChipGeom — the anchor is relative to the cell (round 8)", () => {
  it("an offset resolves against the cell's own start", () => {
    const g = targetChipGeom(cell({ metadata: { target_offset_ms: 2000 } }), { durationMs: 4000 })
    expect(g).toMatchObject({ anchor: 12, start: 12, end: 16 })
  })
  it("the take travels when the cell moves — the whole point", () => {
    const meta = { target_offset_ms: 2000 }
    expect(targetChipGeom(cell({ metadata: meta }), { durationMs: 4000 })?.anchor).toBe(12)
    // Same take, cell dragged 5s later.
    expect(
      targetChipGeom(cell({ startTime: 15, endTime: 25, metadata: meta }), { durationMs: 4000 })?.anchor,
    ).toBe(17)
  })
  it("an offset of exactly 0 is an offset, not an absent key", () => {
    // Truthiness here would fall through to the legacy branch and then to the
    // section start. The two happen to agree at offset 0 — so assert the case
    // that separates them: a legacy key present alongside a zero offset.
    const g = targetChipGeom(
      cell({ metadata: { target_offset_ms: 0, target_start_ms: 99000 } }),
      { durationMs: 4000 },
    )
    expect(g).toMatchObject({ anchor: 10 })
  })
  it("a negative offset leads the line", () => {
    const g = targetChipGeom(cell({ metadata: { target_offset_ms: -1500 } }), { durationMs: 4000 })
    expect(g).toMatchObject({ anchor: 8.5, start: 8.5, end: 12.5 })
  })
  it("the offset wins when both keys are present", () => {
    const g = targetChipGeom(
      cell({ metadata: { target_offset_ms: 2000, target_start_ms: 50000 } }),
      { durationMs: 4000 },
    )
    expect(g).toMatchObject({ anchor: 12 })
  })
  it("legacy takes still resolve absolutely, and do NOT follow the cell", () => {
    // The permanent fallback. A legacy take keeps behaving exactly as it does
    // today until someone next drags it — unchanged, rather than silently moved.
    const meta = { target_start_ms: 12000 }
    expect(targetChipGeom(cell({ metadata: meta }), { durationMs: 4000 })?.anchor).toBe(12)
    expect(
      targetChipGeom(cell({ startTime: 15, endTime: 25, metadata: meta }), { durationMs: 4000 })?.anchor,
    ).toBe(12)
  })
})

describe("targetOffsetMsFor — the inverse", () => {
  it("round-trips through targetChipGeom", () => {
    const c = cell({})
    const offset = targetOffsetMsFor(c, 12.5)
    expect(offset).toBe(2500)
    expect(targetChipGeom(cell({ metadata: { target_offset_ms: offset } }), { durationMs: 1000 })?.anchor)
      .toBe(12.5)
  })
  it("a take before its line is a negative offset, not a clamp", () => {
    expect(targetOffsetMsFor(cell({}), 4)).toBe(-6000)
  })
  it("but never before file zero", () => {
    expect(targetOffsetMsFor(cell({ startTime: 3 }), -2)).toBe(-3000)
    expect(targetOffsetMsFor(cell({ startTime: 0 }), -2)).toBe(0)
  })
  it("a cell with no start treats file zero as its origin", () => {
    expect(targetOffsetMsFor(cell({ startTime: undefined }), 4)).toBe(4000)
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

  it("overlap is clamped to the INTERSECTION — never more than the chip has (2026-08-06)", () => {
    // Degenerate persisted order: this chip starts AFTER the next chip's
    // start. The naive end-minus-start would report 3s on a 2s chip.
    expect(chipOverlaps({ start: 9, end: 11 }, null, 8)).toEqual({ headSec: null, tailSec: 2 })
    // Same on the head side: this chip starts before the PREVIOUS chip does;
    // only the stretch actually under the previous chip counts.
    expect(chipOverlaps({ start: 8, end: 11 }, { start: 9.5, end: 12 }, null)).toEqual({
      headSec: 1.5,
      tailSec: null,
    })
  })

  it("sub-perceptual intrusions are NOT overlaps — a '−0.0s' warning is a lie (2026-08-06)", () => {
    // 30ms past the next chip's start: drag maths land within a few ms of an
    // edge; below the 0.1s display resolution nothing should warn.
    expect(chipOverlaps({ start: 15, end: 23.03 }, null, 23)).toEqual({ headSec: null, tailSec: null })
    expect(chipOverlaps({ start: 18.97, end: 23 }, { start: 15, end: 19 }, null)).toEqual({
      headSec: null,
      tailSec: null,
    })
    // …while a tenth of a second is real.
    expect(chipOverlaps({ start: 15, end: 23.1 }, null, 23)).toEqual({
      headSec: null,
      tailSec: expect.closeTo(0.1, 5),
    })
  })
})
