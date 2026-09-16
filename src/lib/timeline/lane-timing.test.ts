// AQU-646 round 6: per-lane timing resolution — the pure core behind the
// frozen source row, independent subtitle spans, and honest target chips.

import { describe, expect, it } from "vitest"
import {
  chipOverflowState,
  chipOverlaps,
  dualFaultMeetSec,
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

// ── AQU-646 stage 3: the placement moves onto the TAKE ─────────────────────
//
// The reason it had to is one test: two takes share a line once extra target
// tracks exist, and a per-cell anchor would make dragging one chip move the
// other. Everything else here defends the fallback, which stays permanent
// because `rebuild.ts` keeps replaying historical `cell.lane.retime` events
// into the cell's metadata forever.

describe("targetChipGeom — the take's own placement (stage 3)", () => {
  it("uses the take's offset in preference to the cell's", () => {
    const g = targetChipGeom(
      cell({ metadata: { target_offset_ms: 2000 } }),
      { durationMs: 4000, targetOffsetMs: 500 },
    )
    expect(g).toMatchObject({ anchor: 10.5, start: 10.5, end: 14.5 })
  })

  // THE BUG THIS EXISTS TO FIX. Two takes, one line: each sits where IT was
  // placed. Reading the cell would give them both the same anchor, so dragging
  // one would visibly move the other.
  it("keeps two takes on ONE line independently placed", () => {
    const line = cell({ metadata: { target_offset_ms: 2000 } })
    const a = targetChipGeom(line, { durationMs: 4000, targetOffsetMs: 0 })
    const b = targetChipGeom(line, { durationMs: 4000, targetOffsetMs: 3000 })
    expect(a?.anchor).toBe(10)
    expect(b?.anchor).toBe(13)
  })

  it("still follows the line when the line moves", () => {
    const att = { durationMs: 4000, targetOffsetMs: 1000 }
    expect(targetChipGeom(cell({}), att)?.anchor).toBe(11)
    expect(targetChipGeom(cell({ startTime: 15, endTime: 25 }), att)?.anchor).toBe(16)
  })

  // `!= null`, not truthiness — a take placed exactly on its line's start is
  // the common case, and `0` must not fall through to the cell's own anchor.
  it("treats a take offset of exactly 0 as a placement", () => {
    const g = targetChipGeom(
      cell({ metadata: { target_offset_ms: 5000 } }),
      { durationMs: 4000, targetOffsetMs: 0 },
    )
    expect(g).toMatchObject({ anchor: 10 })
  })

  it("falls back to the cell for a take that has never been placed", () => {
    const g = targetChipGeom(cell({ metadata: { target_offset_ms: 2000 } }), { durationMs: 4000 })
    expect(g).toMatchObject({ anchor: 12 })
  })

  it("ignores a non-finite offset rather than drawing the chip nowhere", () => {
    const g = targetChipGeom(
      cell({ metadata: { target_offset_ms: 2000 } }),
      { durationMs: 4000, targetOffsetMs: Number.NaN },
    )
    expect(g).toMatchObject({ anchor: 12 })
  })

  it("a negative take offset leads the line", () => {
    const g = targetChipGeom(cell({}), { durationMs: 4000, targetOffsetMs: -1500 })
    expect(g).toMatchObject({ anchor: 8.5, start: 8.5, end: 12.5 })
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

describe("dualFaultMeetSec — where a mutually-offending pair meets (2026-08-27)", () => {
  /** Both chips in full, because the answer must land inside BOTH of them —
   *  the far edges are what makes that checkable. The starts and ends here are
   *  the ones each case's own comment already describes. */
  const meet = (
    prevChip: [number, number], nextChip: [number, number],
    prevSectionEnd: number, nextSectionStart: number,
  ) =>
    dualFaultMeetSec(
      { chipStartSec: prevChip[0], chipEndSec: prevChip[1], sectionEndSec: prevSectionEnd },
      { chipStartSec: nextChip[0], chipEndSec: nextChip[1], sectionStartSec: nextSectionStart },
    )

  /** The invariant, asserted as a property rather than a number, so it survives
   *  a future retune of where inside the overlap the pair meets. */
  const expectInsideBoth = (at: number, prevChip: [number, number], nextChip: [number, number]) => {
    expect(at).toBeGreaterThanOrEqual(Math.max(prevChip[0], nextChip[0]))
    expect(at).toBeLessThanOrEqual(Math.min(prevChip[1], nextChip[1]))
  }

  it("touching sections collapse to the shared border — the 2026-08-08 cut, unchanged", () => {
    // Sections [10,20]/[20,30]; chips [10,24] and [17,27].
    expect(meet([10, 24], [17, 27], 20, 20)).toBe(20)
  })

  it("across a gap, the pair meets at the midpoint of their overlap", () => {
    // Sam's screenshots, in round seconds: sections end 83.0 / start 83.4,
    // chips end 83.3 / start 83.1 — the overlap [83.1, 83.3] sits wholly
    // inside the gap, so its own midpoint is the meet.
    expect(meet([80.6, 83.3], [83.1, 85.2], 83.0, 83.4)).toBeCloseTo(83.2)
  })

  it("an overlap reaching outside the gap is clamped to the borders first", () => {
    // Gap [19,21]; the next chip reaches back to 18, INSIDE the previous
    // section — the meet must not follow it in there. Zone [19, 20] → 19.5.
    expect(meet([10, 20], [18, 28], 19, 21)).toBeCloseTo(19.5)
    // Mirror: the previous chip reaches past the next SECTION's start.
    expect(meet([10, 22], [20, 30], 19, 21)).toBeCloseTo(20.5)
    // Both ends spill past the gap: the whole gap is the zone.
    expect(meet([10, 22], [18, 30], 19, 21)).toBeCloseTo(20)
  })

  it("overlapping SECTIONS meet between the crossed borders", () => {
    // Sections [10,21]/[19,30] overlap; chips [10,23] and [17,27]. lo/hi
    // invert (21 > 19) and the midpoint lands between the borders — one point,
    // so the painted pair stays disjoint, which the old per-border cuts
    // (end at 21, start at 19) did not.
    expect(meet([10, 23], [17, 27], 21, 19)).toBeCloseTo(20)
  })

  // …AND WHEN THEY OVERLAP FAR ENOUGH, the border zone is not merely inverted
  // but unusable: its midpoint lands outside the chips entirely. Sections
  // [10,20]/[12,30] with chips [10,21]/[11,13] returned 16 — three seconds past
  // the second chip's own end — so `paintedStart` exceeded `paintedEnd` and it
  // rendered as a 10px stub over silence, jumping there as the pointer left.
  it("stays inside both chips when the sections overlap past the next chip's end", () => {
    const prevChip: [number, number] = [10, 21]
    const nextChip: [number, number] = [11, 13]
    const at = meet(prevChip, nextChip, 20, 12)
    expectInsideBoth(at, prevChip, nextChip)
    expect(at).toBeCloseTo(12)
  })

  // The property the four cases above share, stated once: wherever the borders
  // fall, the cut is somewhere both chips actually have audio.
  it("never answers outside the overlap, whatever the borders do", () => {
    const cases: [[number, number], [number, number], number, number][] = [
      [[10, 24], [17, 27], 20, 20],
      [[80.6, 83.3], [83.1, 85.2], 83.0, 83.4],
      [[10, 22], [18, 30], 19, 21],
      [[10, 23], [17, 27], 21, 19],
      [[10, 21], [11, 13], 20, 12],
      // Sections crossed the other way, and a next chip that ends very early.
      [[0, 30], [5, 6], 25, 1],
    ]
    for (const [prevChip, nextChip, prevSectionEnd, nextSectionStart] of cases) {
      expectInsideBoth(meet(prevChip, nextChip, prevSectionEnd, nextSectionStart), prevChip, nextChip)
    }
  })
})
