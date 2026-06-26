import { describe, it, expect } from "vitest"
import { fmtClock, niceTickSec } from "./format"

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

describe("niceTickSec", () => {
  it("widens the step as the zoom shrinks", () => {
    expect(niceTickSec(40)).toBe(2) // 2*40=80 >= 64
    expect(niceTickSec(8)).toBe(10) // 10*8=80 >= 64
  })
})
