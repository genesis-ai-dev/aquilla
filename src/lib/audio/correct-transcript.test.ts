import { describe, expect, it } from "vitest"
import { remapTranscriptTimings } from "./correct-transcript"
import { activeWordRange, timingAddressesText } from "./timings"
import type { WordTiming } from "@/lib/codex-editor/types"

const timings: WordTiming[] = [
  { word: "teh", t0: 0, t1: 0.4, start: 0, end: 3 },
  { word: "house", t0: 0.4, t1: 0.9, start: 4, end: 9 },
]

describe("remapTranscriptTimings", () => {
  it("keeps audio spans when the word count is unchanged", () => {
    const next = remapTranscriptTimings(timings, "the house")
    expect(next).toEqual([
      { word: "the", t0: 0, t1: 0.4, start: 0, end: 3 },
      { word: "house", t0: 0.4, t1: 0.9, start: 4, end: 9 },
    ])
  })

  it("keeps the cell's character offsets when a corrected word is longer", () => {
    // The cell already holds "teh house". A longer correction must not
    // reindex offsets onto that longer string — those offsets would run
    // past the cell and the preview would ask for another transcription.
    const next = remapTranscriptTimings(timings, "the household")
    expect(next).toEqual([
      { word: "the", t0: 0, t1: 0.4, start: 0, end: 3 },
      { word: "household", t0: 0.4, t1: 0.9, start: 4, end: 9 },
    ])
  })

  it("redistributes the original time range when the word count changes", () => {
    const next = remapTranscriptTimings(timings, "the big house")
    expect(next).toHaveLength(3)
    expect(next[0].word).toBe("the")
    expect(next[2].word).toBe("house")
    expect(next[0].t0).toBe(0)
    expect(next[2].t1).toBeCloseTo(0.9)
    expect(next[0].start).toBe(0)
    expect(next[2].end).toBe("the big house".length)
  })

  it("returns [] for blank input", () => {
    expect(remapTranscriptTimings(timings, "   ")).toEqual([])
  })
})

// AQU-2254 — the save that also writes the corrected text onto the cell (an AI
// cleanup of a transcription-mode cell) has to re-offset the words: carrying
// the pre-cleanup offsets over walks the karaoke highlight off its words as
// soon as a correction changes a word's length.
describe("remapTranscriptTimings with reindexOffsets", () => {
  it("re-offsets onto the corrected text when a word gets longer", () => {
    const next = remapTranscriptTimings(timings, "the household", { reindexOffsets: true })
    expect(next).toEqual([
      { word: "the", t0: 0, t1: 0.4, start: 0, end: 3 },
      { word: "household", t0: 0.4, t1: 0.9, start: 4, end: 13 },
    ])
  })

  it("re-offsets onto the corrected text when a word gets shorter", () => {
    const next = remapTranscriptTimings(
      [
        { word: "teh", t0: 0, t1: 0.4, start: 0, end: 3 },
        { word: "household", t0: 0.4, t1: 0.9, start: 4, end: 13 },
      ],
      "a house",
      { reindexOffsets: true },
    )
    expect(next).toEqual([
      { word: "a", t0: 0, t1: 0.4, start: 0, end: 1 },
      { word: "house", t0: 0.4, t1: 0.9, start: 2, end: 7 },
    ])
  })

  it("keeps each word's own audio span rather than redistributing the range", () => {
    const next = remapTranscriptTimings(timings, "the household", { reindexOffsets: true })
    expect(next.map((w) => [w.t0, w.t1])).toEqual([[0, 0.4], [0.4, 0.9]])
  })
})

// The producer (a cleanup save's remapped timings) through its immediate
// consumer (the karaoke span the read view paints, checked against the text it
// is painting) — the composition the drift escaped through.
describe("a cleanup's timings against the text the cell now holds", () => {
  it("highlights the right word after a lengthening cleanup", () => {
    const cleaned = "the household"
    const next = remapTranscriptTimings(timings, cleaned, { reindexOffsets: true })
    const active = activeWordRange(next, 0.6)!
    expect(active).toEqual({ start: 4, end: 13, word: "household" })
    expect(timingAddressesText(active, cleaned)).toBe(true)
  })

  it("highlights the right word after a shortening cleanup", () => {
    const cleaned = "a house"
    const next = remapTranscriptTimings(
      [
        { word: "teh", t0: 0, t1: 0.4, start: 0, end: 3 },
        { word: "household", t0: 0.4, t1: 0.9, start: 4, end: 13 },
      ],
      cleaned,
      { reindexOffsets: true },
    )
    const active = activeWordRange(next, 0.6)!
    expect(active).toEqual({ start: 2, end: 7, word: "house" })
    expect(timingAddressesText(active, cleaned)).toBe(true)
  })

  it("refuses the span — never paints the wrong letters — when offsets are carried over", () => {
    const cleaned = "the household"
    const next = remapTranscriptTimings(timings, cleaned)
    const active = activeWordRange(next, 0.6)!
    expect(timingAddressesText(active, cleaned)).toBe(false)
  })
})
