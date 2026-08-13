import { describe, expect, it } from "vitest"
import { remapTranscriptTimings } from "./correct-transcript"
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
