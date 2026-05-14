import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import {
  findActiveTimingIndex,
  readCellTimings,
  tokenizeWords,
  uniformTimings,
  writeCellTimings,
  clearCellTimings,
} from "./timings"
import type { WordTiming } from "@/lib/codex-editor/types"

function seedDoc(cellId: string): Y.Doc {
  const doc = new Y.Doc()
  const cellsMap = doc.getMap("cells")
  cellsMap.set(cellId, new Y.Map())
  return doc
}

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

describe("read/write cell timings", () => {
  it("round-trips through the Y.Doc", () => {
    const doc = seedDoc("c1")
    const ts: WordTiming[] = [
      { word: "hi", t0: 0, t1: 0.4, start: 0, end: 2 },
      { word: "world", t0: 0.4, t1: 1.0, start: 3, end: 8 },
    ]
    writeCellTimings(doc, "c1", "audio-1", ts)
    expect(readCellTimings(doc, "c1", "audio-1")).toEqual(ts)
  })

  it("overwrites an existing entry rather than appending", () => {
    const doc = seedDoc("c1")
    writeCellTimings(doc, "c1", "audio-1", [
      { word: "old", t0: 0, t1: 1, start: 0, end: 3 },
    ])
    writeCellTimings(doc, "c1", "audio-1", [
      { word: "new", t0: 0, t1: 1, start: 0, end: 3 },
    ])
    const back = readCellTimings(doc, "c1", "audio-1")
    expect(back?.length).toBe(1)
    expect(back?.[0].word).toBe("new")
  })

  it("keeps timings for different audioIds isolated", () => {
    const doc = seedDoc("c1")
    writeCellTimings(doc, "c1", "audio-1", [{ word: "a", t0: 0, t1: 1, start: 0, end: 1 }])
    writeCellTimings(doc, "c1", "audio-2", [{ word: "b", t0: 0, t1: 1, start: 0, end: 1 }])
    expect(readCellTimings(doc, "c1", "audio-1")?.[0].word).toBe("a")
    expect(readCellTimings(doc, "c1", "audio-2")?.[0].word).toBe("b")
  })

  it("returns undefined for unknown cells / audio ids", () => {
    const doc = seedDoc("c1")
    expect(readCellTimings(doc, "missing", "audio-1")).toBeUndefined()
    expect(readCellTimings(doc, "c1", "audio-1")).toBeUndefined()
  })

  it("clears timings", () => {
    const doc = seedDoc("c1")
    writeCellTimings(doc, "c1", "audio-1", [{ word: "x", t0: 0, t1: 1, start: 0, end: 1 }])
    clearCellTimings(doc, "c1", "audio-1")
    expect(readCellTimings(doc, "c1", "audio-1")).toBeUndefined()
  })
})
