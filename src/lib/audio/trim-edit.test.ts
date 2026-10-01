import { describe, expect, it } from "vitest"
import { formatTrimTime, keptLengthSec, moveTrimEnd, moveTrimStart, sameTrim } from "./trim-edit"
import { MIN_TARGET_LEN_SEC } from "@/lib/timeline/lane-timing"

const open = { start: null, end: null }

describe("moveTrimStart", () => {
  it("moves the start edge in past leading silence", () => {
    expect(moveTrimStart(open, 0.4, 3)).toEqual({ start: 0.4, end: null })
  })

  it("cannot cross the end edge or close below the timeline's minimum", () => {
    expect(moveTrimStart({ start: null, end: 2 }, 2.5, 3)).toEqual({ start: 2 - MIN_TARGET_LEN_SEC, end: 2 })
  })

  it("clears the trim when dragged back to the clip's edge", () => {
    expect(moveTrimStart({ start: 0.4, end: null }, 0.01, 3)).toEqual({ start: null, end: null })
    expect(moveTrimStart({ start: 0.4, end: null }, -1, 3)).toEqual({ start: null, end: null })
  })

  it("lets a single arrow nudge step in from the edge without snapping back", () => {
    expect(moveTrimStart(open, 0.01, 3, { snap: false })).toEqual({ start: 0.01, end: null })
    expect(moveTrimEnd(open, 2.99, 3, { snap: false })).toEqual({ start: null, end: 2.99 })
    expect(moveTrimStart({ start: 0.01, end: null }, 0, 3, { snap: false })).toEqual({ start: null, end: null })
  })

  it("does nothing without a known length", () => {
    expect(moveTrimStart(open, 0.4, 0)).toBe(open)
  })
})

describe("moveTrimEnd", () => {
  it("moves the end edge in past trailing silence", () => {
    expect(moveTrimEnd(open, 2.6, 3)).toEqual({ start: null, end: 2.6 })
  })

  it("cannot cross the start edge", () => {
    expect(moveTrimEnd({ start: 1, end: null }, 0.5, 3)).toEqual({ start: 1, end: 1 + MIN_TARGET_LEN_SEC })
  })

  it("clears the trim at the clip's end", () => {
    expect(moveTrimEnd({ start: null, end: 2.6 }, 2.99, 3)).toEqual({ start: null, end: null })
  })
})

describe("keptLengthSec / sameTrim", () => {
  it("measures the part that plays", () => {
    expect(keptLengthSec({ start: 0.3, end: 2.7 }, 3)).toBeCloseTo(2.4)
    expect(keptLengthSec(open, 3)).toBe(3)
  })

  it("compares to the millisecond", () => {
    expect(sameTrim({ start: 0.3, end: null }, { start: 0.3004, end: null })).toBe(true)
    expect(sameTrim({ start: 0.3, end: null }, { start: 0.31, end: null })).toBe(false)
  })
})

describe("formatTrimTime", () => {
  it("shows a line's time to the hundredth, so one 10ms nudge always shows", () => {
    expect(formatTrimTime(0.52)).toBe("0:00.52")
    expect(formatTrimTime(0.53)).toBe("0:00.53")
    expect(formatTrimTime(62.3)).toBe("1:02.30")
    expect(formatTrimTime(59.999)).toBe("1:00.00")
    expect(formatTrimTime(-1)).toBe("0:00.00")
  })
})
