import { describe, expect, it } from "vitest"
import {
  activeWordRange,
  alignChunks,
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

describe("alignChunks", () => {
  const chunks = [
    { text: "Hello", start: 0, end: 0.4 },
    { text: "there", start: 0.4, end: 0.9 },
  ]

  it("indexes against cell text when word counts match 1:1", () => {
    // Cell text differs from the transcript — karaoke must paint what the
    // user typed, so offsets come from the cell text, not Whisper's output.
    const out = alignChunks(chunks, "Bonjour toi")
    expect(out).toEqual([
      { word: "Bonjour", start: 0, end: 7, t0: 0, t1: 0.4 },
      { word: "toi", start: 8, end: 11, t0: 0.4, t1: 0.9 },
    ])
  })

  it("falls back to transcript offsets when word counts differ", () => {
    const out = alignChunks(chunks, "one two three")
    // Transcript is "Hello there" — offsets index into that string.
    expect(out).toEqual([
      { word: "Hello", start: 0, end: 5, t0: 0, t1: 0.4 },
      { word: "there", start: 6, end: 11, t0: 0.4, t1: 0.9 },
    ])
  })

  it("falls back to transcript offsets when cell text is missing", () => {
    const out = alignChunks(chunks, undefined)
    expect(out[0]).toMatchObject({ word: "Hello", start: 0, end: 5 })
  })

  it("returns empty for no chunks", () => {
    expect(alignChunks([], "hello")).toEqual([])
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

describe("activeWordRange", () => {
  const timings: WordTiming[] = [
    { word: "hello", t0: 0, t1: 0.5, start: 0, end: 5 },
    { word: "world", t0: 0.5, t1: 1.0, start: 6, end: 11 },
  ]
  it("returns the plain-text span of the active word", () => {
    expect(activeWordRange(timings, 0.2)).toEqual({ start: 0, end: 5 })
    expect(activeWordRange(timings, 0.7)).toEqual({ start: 6, end: 11 })
  })
  it("advances the span as playback crosses a word boundary", () => {
    // The read-view karaoke highlight must move word-to-word, not stick.
    expect(activeWordRange(timings, 0.49)).toEqual({ start: 0, end: 5 })
    expect(activeWordRange(timings, 0.5)).toEqual({ start: 6, end: 11 })
  })
  it("returns null when no word is active (before/after/paused-past-end)", () => {
    expect(activeWordRange(timings, -1)).toBeNull()
    expect(activeWordRange(timings, 5)).toBeNull()
    expect(activeWordRange(undefined, 0.2)).toBeNull()
  })
  it("returns null for a degenerate zero-width span", () => {
    expect(activeWordRange([{ word: "", t0: 0, t1: 1, start: 3, end: 3 }], 0.5)).toBeNull()
  })
})
