import { describe, expect, it } from "vitest"
import { alignChunks } from "./transcribe"

const chunks = [
  { text: "hello", start: 0.0, end: 0.4 },
  { text: "world", start: 0.5, end: 0.9 },
]

describe("alignChunks", () => {
  it("uses cell-text offsets when chunk count matches the cell's word count", () => {
    const out = alignChunks(chunks, "Hello world")
    expect(out.length).toBe(2)
    expect(out[0]).toMatchObject({ word: "Hello", start: 0, end: 5, t0: 0.0, t1: 0.4 })
    expect(out[1]).toMatchObject({ word: "world", start: 6, end: 11, t0: 0.5, t1: 0.9 })
  })

  it("falls back to transcript-text offsets on a length mismatch", () => {
    const out = alignChunks(chunks, "Hello there world")
    expect(out.length).toBe(2)
    expect(out[0].word).toBe("hello")
    expect(out[1].word).toBe("world")
    expect(out[0].t0).toBe(0)
    expect(out[1].t1).toBe(0.9)
  })

  it("handles missing cell text by indexing against the transcript", () => {
    const out = alignChunks(chunks, undefined)
    expect(out.length).toBe(2)
    expect(out[0].word).toBe("hello")
    expect(out[1].word).toBe("world")
  })

  it("returns empty for no chunks", () => {
    expect(alignChunks([], "anything")).toEqual([])
  })
})
