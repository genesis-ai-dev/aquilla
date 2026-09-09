// AQU-1068 item 5. The two pure halves of typing a timestamp: reading what
// somebody wrote, and keeping the result inside its neighbours.

import { describe, expect, it } from "vitest"
import { MIN_ADDABLE_SPAN_SEC } from "./lane-timing"
import { clampSpan, parseTimecode } from "./timecode"

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

describe("clampSpan", () => {
  const bounds = (over: Partial<Parameters<typeof clampSpan>[0]> = {}) => ({
    startSec: 10,
    endSec: 12,
    prevEndSec: 5,
    nextStartSec: 20,
    ...over,
  })

  it("leaves a span that already fits exactly as it was", () => {
    expect(clampSpan(bounds())).toEqual({ startSec: 10, endSec: 12, clamped: false })
  })

  it("holds the start at the previous line's end", () => {
    // Letting it past would make the anchor chain and the clock disagree
    // about which line comes first — the divergence this PR spent rounds
    // removing.
    const out = clampSpan(bounds({ startSec: 2 }))
    expect(out.startSec).toBe(5)
    expect(out.clamped).toBe(true)
  })

  it("holds the end at the next line's start", () => {
    const out = clampSpan(bounds({ endSec: 30 }))
    expect(out.endSec).toBe(20)
    expect(out.clamped).toBe(true)
  })

  it("treats a missing neighbour as open-ended", () => {
    // The last line of a file with no known duration may run as long as it
    // likes; the first may start at zero.
    const out = clampSpan(bounds({ startSec: 0, endSec: 9999, prevEndSec: null, nextStartSec: null }))
    expect(out).toEqual({ startSec: 0, endSec: 9999, clamped: false })
  })

  it("never lets the span start before zero", () => {
    expect(clampSpan(bounds({ startSec: -4, prevEndSec: null })).startSec).toBe(0)
  })

  it("grows the END to the minimum span, since the start is what they aimed at", () => {
    const out = clampSpan(bounds({ startSec: 10, endSec: 10 }))
    expect(out.startSec).toBe(10)
    expect(out.endSec).toBeCloseTo(10 + MIN_ADDABLE_SPAN_SEC, 6)
    expect(out.clamped).toBe(true)
  })

  it("pushes the START back only when there is no room after it", () => {
    // A silence barely wider than the floor: the end has nowhere to grow to,
    // so the start gives way instead.
    const out = clampSpan({ startSec: 19.9, endSec: 19.95, prevEndSec: 5, nextStartSec: 20 })
    expect(out.endSec).toBe(20)
    expect(out.startSec).toBeCloseTo(20 - MIN_ADDABLE_SPAN_SEC, 6)
    expect(out.clamped).toBe(true)
  })

  it("repairs an inverted span rather than saving it", () => {
    const out = clampSpan(bounds({ startSec: 15, endSec: 11 }))
    expect(out.endSec).toBeGreaterThan(out.startSec)
    expect(out.clamped).toBe(true)
  })

  it("does not call a sub-millisecond difference a clamp", () => {
    // The write rounds to whole milliseconds, so anything finer is not a
    // change the user could observe — reporting it would make the popover
    // claim it corrected something when it did not.
    const out = clampSpan(bounds({ startSec: 10.00004 }))
    expect(out.clamped).toBe(false)
  })
})
