import { describe, it, expect } from "vitest"
import { fmtClock, fmtCueClock, niceTickSec } from "./format"

describe("fmtClock", () => {
  it("formats m:ss", () => {
    expect(fmtClock(0)).toBe("0:00")
    expect(fmtClock(65)).toBe("1:05")
  })
  it("adds tenths on request", () => {
    expect(fmtClock(3.14, true)).toBe("0:03.1")
  })
  it("guards NaN / negatives to 0", () => {
    expect(fmtClock(-5)).toBe("0:00")
    expect(fmtClock(NaN)).toBe("0:00")
  })
})

describe("fmtCueClock (Sam's D2: a caption list's times)", () => {
  it("reads m:ss, with a tenth only when there is one", () => {
    expect(fmtCueClock(1)).toBe("0:01")
    expect(fmtCueClock(4)).toBe("0:04")
    expect(fmtCueClock(65.5)).toBe("1:05.5")
  })
  it("rounds a parser's float noise to the nearest tenth", () => {
    // long-episode.vtt's second cue: 00:00:02.712 parses to 2.7119999999999997.
    expect(fmtCueClock(2.7119999999999997)).toBe("0:02.7")
    expect(fmtCueClock(59.96)).toBe("1:00")
  })
  it("adds an hours field past an hour, and guards NaN / negatives to 0", () => {
    expect(fmtCueClock(3723.4)).toBe("1:02:03.4")
    expect(fmtCueClock(-1)).toBe("0:00")
    expect(fmtCueClock(NaN)).toBe("0:00")
  })
})

describe("niceTickSec", () => {
  it("widens the step as the zoom shrinks", () => {
    expect(niceTickSec(40)).toBe(2) // 2*40=80 >= 64
    expect(niceTickSec(8)).toBe(10) // 10*8=80 >= 64
  })
})
