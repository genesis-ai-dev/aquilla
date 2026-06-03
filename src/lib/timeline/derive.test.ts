import { describe, it, expect } from "vitest"
import {
  hasTiming,
  timelineBounds,
  rangesOverlap,
  overlapsOf,
  sortByLens,
  sequenceBetween,
  type TimelineSegment,
} from "./derive"

// WHY these tests exist: `orderedBy` must be a pure display lens — ordering and
// association are DERIVED, never stored, and timing is never synthesized. Each
// test pins one of those invariants so a regression that secretly mutates or
// fabricates data fails loudly.

const seg = (s: Partial<TimelineSegment>): TimelineSegment => ({ ...s })

describe("hasTiming", () => {
  it("requires a finite start AND end", () => {
    expect(hasTiming(seg({ startTime: 1, endTime: 2 }))).toBe(true)
    expect(hasTiming(seg({ startTime: 1 }))).toBe(false)
    expect(hasTiming(seg({}))).toBe(false)
    expect(hasTiming(seg({ startTime: NaN, endTime: 2 }))).toBe(false)
  })
})

describe("timelineBounds", () => {
  it("spans the fullest range of timed segments", () => {
    expect(
      timelineBounds([
        seg({ startTime: 10, endTime: 14 }),
        seg({ startTime: 3870, endTime: 3900 }),
        seg({ sequenceIndex: 2 }), // untimed — ignored
      ])
    ).toEqual({ start: 10, end: 3900 })
  })

  it("returns null when nothing is timed (the 'no timing' lens state)", () => {
    expect(timelineBounds([seg({ sequenceIndex: 0 }), seg({ sequenceIndex: 1 })])).toBeNull()
  })
})

describe("rangesOverlap", () => {
  it("is half-open: touching edges do not overlap", () => {
    expect(rangesOverlap(0, 2, 2, 4)).toBe(false)
    expect(rangesOverlap(0, 3, 2, 4)).toBe(true)
  })
})

describe("overlapsOf", () => {
  const sub = seg({ startTime: 0, endTime: 6, medium: "text" })
  const a1 = seg({ startTime: 0, endTime: 3, medium: "media" })
  const a2 = seg({ startTime: 3, endTime: 5, medium: "media" })
  const a3 = seg({ startTime: 8, endTime: 10, medium: "media" })
  const all = [sub, a1, a2, a3]

  it("finds time-overlapping segments, excluding self", () => {
    expect(overlapsOf(sub, all)).toEqual([a1, a2])
  })

  it("can filter by medium (advisory cross-track association)", () => {
    expect(overlapsOf(sub, all, { medium: "media" })).toEqual([a1, a2])
    expect(overlapsOf(a1, all, { medium: "text" })).toEqual([sub])
  })

  it("an untimed target overlaps nothing", () => {
    expect(overlapsOf(seg({ sequenceIndex: 1 }), all)).toEqual([])
  })
})

describe("sortByLens", () => {
  it("does not mutate the input array", () => {
    const input = [seg({ sequenceIndex: 1 }), seg({ sequenceIndex: 0 })]
    const snapshot = [...input]
    sortByLens(input, "sequence")
    expect(input).toEqual(snapshot)
  })

  it("sequence lens orders by sequenceIndex", () => {
    const out = sortByLens(
      [
        seg({ sequenceIndex: 2, startTime: 0, endTime: 1 }),
        seg({ sequenceIndex: 0, startTime: 99, endTime: 100 }),
        seg({ sequenceIndex: 1 }),
      ],
      "sequence"
    )
    expect(out.map((s) => s.sequenceIndex)).toEqual([0, 1, 2])
  })

  it("time lens orders timed segments by start", () => {
    const out = sortByLens(
      [
        seg({ sequenceIndex: 0, startTime: 30, endTime: 31 }),
        seg({ sequenceIndex: 1, startTime: 10, endTime: 11 }),
      ],
      "time"
    )
    expect(out.map((s) => s.startTime)).toEqual([10, 30])
  })

  it("time lens homes an untimed segment between its bracketing neighbors", () => {
    // #1 timed @10, #2 timed @14, #3 UNTIMED, #4 timed @3870 (1:04:30)
    const s1 = seg({ sequenceIndex: 1, startTime: 10, endTime: 14 })
    const s2 = seg({ sequenceIndex: 2, startTime: 14, endTime: 19 })
    const s3 = seg({ sequenceIndex: 3 }) // no timing
    const s4 = seg({ sequenceIndex: 4, startTime: 3870, endTime: 3900 })
    const out = sortByLens([s4, s3, s1, s2], "time")
    expect(out).toEqual([s1, s2, s3, s4])
  })

  it("time lens falls back to sequence order when nothing is timed", () => {
    const out = sortByLens([seg({ sequenceIndex: 2 }), seg({ sequenceIndex: 0 }), seg({ sequenceIndex: 1 })], "time")
    expect(out.map((s) => s.sequenceIndex)).toEqual([0, 1, 2])
  })
})

describe("sequenceBetween", () => {
  it("returns the midpoint between two neighbors", () => {
    expect(sequenceBetween(2, 3)).toBe(2.5)
  })
  it("steps past a single neighbor at either end", () => {
    expect(sequenceBetween(5, undefined)).toBe(6)
    expect(sequenceBetween(undefined, 5)).toBe(4)
  })
  it("defaults to 0 for the very first segment", () => {
    expect(sequenceBetween()).toBe(0)
  })
})
