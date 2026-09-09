// AQU-1068 item 5. The two pure halves of typing a timestamp: reading what
// somebody wrote, and keeping the result inside its neighbours.

import { describe, expect, it } from "vitest"
import { parseTimecode, spanProblem } from "./timecode"

describe("parseTimecode", () => {
  it("reads the format the idle chip shows, which is what people copy", () => {
    // `fmtClock(sec, true)` — the readout on every timeline card.
    expect(parseTimecode("1:02.5")).toBeCloseTo(62.5, 6)
  })

  it("reads the format the drag readout shows", () => {
    // `fmtDragTime` — MM:SS.mmm, the precise-entry format.
    expect(parseTimecode("01:02.500")).toBeCloseTo(62.5, 6)
  })

  it("reads a full VTT/SRT timestamp, comma or dot", () => {
    expect(parseTimecode("00:01:02.500")).toBeCloseTo(62.5, 6)
    expect(parseTimecode("00:01:02,500")).toBeCloseTo(62.5, 6)
  })

  it("reads bare seconds, the fastest thing to type", () => {
    expect(parseTimecode("62")).toBe(62)
    expect(parseTimecode("62.5")).toBeCloseTo(62.5, 6)
    expect(parseTimecode("0")).toBe(0)
  })

  it("reads milliseconds POSITIONALLY, so a tenth is not a thousandth", () => {
    // The trap a naive parseInt falls into: ".5" is half a second. Getting
    // this wrong is invisible in testing (everything still saves) and moves
    // every typed cue by up to a second.
    expect(parseTimecode("0.5")).toBeCloseTo(0.5, 6)
    expect(parseTimecode("0.05")).toBeCloseTo(0.05, 6)
    expect(parseTimecode("0.005")).toBeCloseTo(0.005, 6)
  })

  it("accepts one or two digit minutes and seconds", () => {
    expect(parseTimecode("1:2")).toBe(62)
    expect(parseTimecode("01:02")).toBe(62)
  })

  it("lets the LEADING field run past its usual range", () => {
    // "90:00" is a real way to type ninety minutes; a film runs past 99.
    expect(parseTimecode("90:00")).toBe(5400)
    expect(parseTimecode("100:00:00")).toBe(360000)
  })

  it("refuses an out-of-range field that is NOT leading", () => {
    // `1:90:00` is a typo for 2:30:00, and reading it as ninety
    // minutes-past-the-hour would be a guess about what they meant.
    expect(parseTimecode("1:90:00")).toBeNull()
    expect(parseTimecode("1:02:99")).toBeNull()
  })

  it("returns null, never 0, for anything unreadable", () => {
    // The caller must tell "the start of the file" from "not a time".
    // Committing 0 would move the cue to the top of the film.
    for (const bad of ["", "   ", "abc", "1:", ":30", "1:2:3:4", "1.2.3", "-5", "1e3", "٣٠"]) {
      expect(parseTimecode(bad), bad).toBeNull()
    }
  })

  it("ignores surrounding whitespace", () => {
    expect(parseTimecode("  1:02.5  ")).toBeCloseTo(62.5, 6)
  })

  it("round-trips its own output format", () => {
    // Whatever the popover writes back into the field must read again.
    expect(parseTimecode("00:00:00.000")).toBe(0)
    expect(parseTimecode("02:03:04.567")).toBeCloseTo(7384.567, 6)
  })
})

// Sam, 2026-09-09, testing the popover: "when timestamps are edited manually,
// overlap should be allowed. also, we should make sure it is not possible to
// set the start time after the end time or vice-versa."
//
// The first half reverses an earlier clamp that held a typed span inside its
// neighbours. That was too strict: the media lens sorts on START time, so a
// line overlapping the one before it still sorts after it and the chain and
// the clock agree. Typing exact times is exactly when somebody wants two
// speakers talking over each other.
describe("spanProblem", () => {
  it("accepts an ordinary span", () => {
    expect(spanProblem(10, 12)).toBeNull()
  })

  it("ALLOWS a span that overlaps its neighbours — that is the point", () => {
    // Nothing here knows about neighbours any more, which is the change: a
    // caller cannot accidentally reintroduce the bound by passing them.
    expect(spanProblem.length).toBe(2)
    expect(spanProblem(0, 9999)).toBeNull()
  })

  it("refuses an end BEFORE its start", () => {
    expect(spanProblem(15, 11)).toBe("inverted")
  })

  it("refuses an end EQUAL to its start — a cue of no length says nothing", () => {
    expect(spanProblem(10, 10)).toBe("inverted")
  })

  it("judges in whole milliseconds, because that is what gets stored", () => {
    // Two values a microsecond apart are the same instant once written, so
    // calling that a valid span would store a cue of no length.
    expect(spanProblem(10, 10.0000001)).toBe("inverted")
    expect(spanProblem(10, 10.001)).toBeNull()
  })

  it("does not mind a span starting at zero", () => {
    expect(spanProblem(0, 1)).toBeNull()
  })
})
