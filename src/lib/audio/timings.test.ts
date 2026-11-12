import { describe, expect, it } from "vitest"
import {
  activeWordRange,
  alignChunks,
  timingAddressesText,
  findActiveTimingIndex,
  findTimingAtPlainOffset,
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

describe("findTimingAtPlainOffset", () => {
  const timings: WordTiming[] = [
    { word: "hello", t0: 0, t1: 0.4, start: 0, end: 5 },
    { word: "world", t0: 0.4, t1: 0.9, start: 6, end: 11 },
  ]
  it("returns the word covering the offset", () => {
    expect(findTimingAtPlainOffset(timings, 0)?.word).toBe("hello")
    expect(findTimingAtPlainOffset(timings, 4)?.word).toBe("hello")
    expect(findTimingAtPlainOffset(timings, 6)?.word).toBe("world")
  })
  it("snaps a gap (the space) to the nearest word", () => {
    expect(findTimingAtPlainOffset(timings, 5)?.word).toBe("world")
  })
  it("returns undefined when there are no timings", () => {
    expect(findTimingAtPlainOffset(undefined, 0)).toBeUndefined()
    expect(findTimingAtPlainOffset([], 0)).toBeUndefined()
  })
})

describe("activeWordRange", () => {
  const timings: WordTiming[] = [
    { word: "hello", t0: 0, t1: 0.5, start: 0, end: 5 },
    { word: "world", t0: 0.5, t1: 1.0, start: 6, end: 11 },
  ]
  it("returns the plain-text span of the active word", () => {
    expect(activeWordRange(timings, 0.2)).toEqual({ start: 0, end: 5, word: "hello" })
    expect(activeWordRange(timings, 0.7)).toEqual({ start: 6, end: 11, word: "world" })
  })
  it("advances the span as playback crosses a word boundary", () => {
    // The read-view karaoke highlight must move word-to-word, not stick.
    expect(activeWordRange(timings, 0.49)).toEqual({ start: 0, end: 5, word: "hello" })
    expect(activeWordRange(timings, 0.5)).toEqual({ start: 6, end: 11, word: "world" })
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

describe("timingAddressesText", () => {
  // AQU-2254: the character offsets of a word timing are only usable while
  // they still select the word they name. A transcript cleanup rewrites the
  // text underneath them without moving them.
  const cases: Array<{ name: string; timing: WordTiming; text: string; ok: boolean }> = [
    {
      name: "the word it names is at those offsets",
      timing: { word: "house", t0: 0, t1: 1, start: 4, end: 9 },
      text: "the house",
      ok: true,
    },
    {
      name: "punctuation and case differ but the word is the same",
      timing: { word: "House,", t0: 0, t1: 1, start: 4, end: 9 },
      text: "the house",
      ok: true,
    },
    {
      name: "a cleanup lengthened an earlier word, shifting this one right",
      // "the house" → "that house": offsets 4..9 now select "house"[-1] = "hous"
      timing: { word: "house", t0: 0, t1: 1, start: 4, end: 9 },
      text: "that house",
      ok: false,
    },
    {
      name: "a cleanup shortened an earlier word, shifting this one left",
      timing: { word: "house", t0: 0, t1: 1, start: 4, end: 9 },
      text: "a house",
      ok: false,
    },
    {
      name: "a cleanup replaced the word itself",
      timing: { word: "house", t0: 0, t1: 1, start: 4, end: 9 },
      text: "the HORSE",
      ok: false,
    },
    {
      name: "the offsets run past the end of the text",
      timing: { word: "household", t0: 0, t1: 1, start: 4, end: 13 },
      text: "the house",
      ok: false,
    },
    {
      name: "a degenerate zero-width span",
      timing: { word: "", t0: 0, t1: 1, start: 3, end: 3 },
      text: "the house",
      ok: false,
    },
  ]
  it.each(cases)("$name → $ok", ({ timing, text, ok }) => {
    expect(timingAddressesText(timing, text)).toBe(ok)
  })
})

describe("activeWordRange carries the word its span claims", () => {
  // AQU-2254: the span alone cannot be checked. Whoever paints it holds the
  // text and needs the word to compare against.
  const timings: WordTiming[] = [
    { word: "the", t0: 0, t1: 0.5, start: 0, end: 3 },
    { word: "house", t0: 0.5, t1: 1.0, start: 4, end: 9 },
  ]
  it("reports the active word alongside its offsets", () => {
    expect(activeWordRange(timings, 0.7)).toEqual({ start: 4, end: 9, word: "house" })
  })
  it("composes with timingAddressesText over the text being painted", () => {
    const active = activeWordRange(timings, 0.7)!
    expect(timingAddressesText(active, "the house")).toBe(true)
    // An AI cleanup lengthened the first word; the span slid onto "hous".
    expect(timingAddressesText(active, "that house")).toBe(false)
  })
})
