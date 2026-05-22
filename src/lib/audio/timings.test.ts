import { describe, expect, it } from "vitest"
import {
  findActiveTimingIndex,
  tokenizeWords,
  uniformTimings,
} from "./timings"
import type { WordTiming } from "@/lib/codex-editor/types"

describe("tokenizeWords", () => {
  it("splits on whitespace and reports inclusive/exclusive offsets", () => {
    const out = tokenizeWords("hello  world\tfriend")
    expect(out).toEqual([
      { word: "hello", start: 0, end: 5 },
      { word: "world", start: 7, end: 12 },
      { word: "friend", start: 13, end: 19 },
    ])
  })
  it("handles leading and trailing whitespace", () => {
    expect(tokenizeWords("   hi   ")).toEqual([{ word: "hi", start: 3, end: 5 }])
  })
  it("returns empty for whitespace-only text", () => {
    expect(tokenizeWords("   \t\n ")).toEqual([])
  })
})

describe("uniformTimings", () => {
  it("spreads duration evenly across tokens", () => {
    const out = uniformTimings("a b c d", 4)
    expect(out.length).toBe(4)
    expect(out[0]).toMatchObject({ word: "a", t0: 0, t1: 1 })
    expect(out[3]).toMatchObject({ word: "d", t0: 3, t1: 4 })
  })
  it("returns empty for zero duration or empty text", () => {
    expect(uniformTimings("a b", 0)).toEqual([])
    expect(uniformTimings("", 5)).toEqual([])
  })
})

describe("findActiveTimingIndex", () => {
  const timings: WordTiming[] = [
    { word: "a", t0: 0, t1: 0.5, start: 0, end: 1 },
    { word: "b", t0: 0.5, t1: 1.0, start: 2, end: 3 },
    { word: "c", t0: 1.0, t1: 2.0, start: 4, end: 5 },
  ]
  it("returns the containing index", () => {
    expect(findActiveTimingIndex(timings, 0.0)).toBe(0)
    expect(findActiveTimingIndex(timings, 0.49)).toBe(0)
    expect(findActiveTimingIndex(timings, 0.5)).toBe(1)
    expect(findActiveTimingIndex(timings, 1.5)).toBe(2)
  })
  it("returns -1 outside the range", () => {
    expect(findActiveTimingIndex(timings, -0.1)).toBe(-1)
    expect(findActiveTimingIndex(timings, 2.0)).toBe(-1)
  })
  it("returns -1 for missing timings", () => {
    expect(findActiveTimingIndex(undefined, 1)).toBe(-1)
    expect(findActiveTimingIndex([], 1)).toBe(-1)
  })
})
