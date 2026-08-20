import { describe, expect, it, vi } from "vitest"
import {
  buildBoundaries,
  parseSegmentReply,
  segmentWithModel,
  MAX_WINDOWS,
  MIN_SEGMENT_CELLS,
  WINDOW_CELLS,
} from "./segment-model"
import { pair, scriptedLlm } from "./test-helpers"
import type { LlmCall } from "./types"

const cells = (n: number, prefix = "c") => Array.from({ length: n }, (_, i) => pair(`${prefix}${i + 1}`))
const passages = (...entries: { line: number; title?: string; gist?: string }[]) =>
  JSON.stringify({ passages: entries })

describe("parseSegmentReply", () => {
  it("reads line numbers with their title and gist, sorted", () => {
    const parsed = parseSegmentReply(
      passages({ line: 9, title: "Second" }, { line: 1, title: "First", gist: "It begins." }),
      12,
    )
    expect(parsed.map((b) => b.index)).toEqual([0, 8])
    expect(parsed[0]).toMatchObject({ title: "First", gist: "It begins." })
  })

  it("tolerates prose around the object", () => {
    expect(parseSegmentReply(`Sure!\n${passages({ line: 3 })}\nDone.`, 10)).toHaveLength(1)
  })

  it("drops lines outside the window, duplicates, and malformed entries", () => {
    const parsed = parseSegmentReply(
      JSON.stringify({ passages: [{ line: 0 }, { line: 99 }, { line: 3 }, { line: 3 }, { line: "x" }, null] }),
      10,
    )
    expect(parsed.map((b) => b.index)).toEqual([2])
  })

  it("returns nothing for unparseable or wrongly-shaped replies", () => {
    expect(parseSegmentReply("no json", 10)).toEqual([])
    expect(parseSegmentReply('{"ok":true}', 10)).toEqual([])
    expect(parseSegmentReply('{"passages":"nope"}', 10)).toEqual([])
  })

  it("drops blank titles rather than storing empty strings", () => {
    const parsed = parseSegmentReply(passages({ line: 1, title: "   ", gist: "" }), 5)
    expect(parsed[0].title).toBeUndefined()
    expect(parsed[0].gist).toBeUndefined()
  })
})

describe("buildBoundaries", () => {
  const pairs = cells(20)

  it("builds contiguous segments that cover the file exactly", () => {
    const built = buildBoundaries(pairs, [{ index: 0 }, { index: 7 }, { index: 14 }])
    expect(built.map((b) => [b.startCellId, b.endCellId])).toEqual([
      ["c1", "c7"],
      ["c8", "c14"],
      ["c15", "c20"],
    ])
  })

  it("cannot produce a gap or an overlap even from unsorted, out-of-range breaks", () => {
    const built = buildBoundaries(pairs, [{ index: 14 }, { index: -5 }, { index: 999 }, { index: 7 }])
    const starts = built.map((b) => pairs.findIndex((p) => p.cellId === b.startCellId))
    const ends = built.map((b) => pairs.findIndex((p) => p.cellId === b.endCellId))
    expect(starts[0]).toBe(0)
    expect(ends[ends.length - 1]).toBe(pairs.length - 1)
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBe(ends[i - 1] + 1)
  })

  it("drops a break that would leave a sub-minimum segment", () => {
    // A break one cell after the previous one would make a 1-cell passage.
    const built = buildBoundaries(pairs, [{ index: 0 }, { index: 1 }, { index: 10 }])
    expect(built).toHaveLength(2)
    expect(built[0]).toMatchObject({ startCellId: "c1", endCellId: "c10" })
    expect(MIN_SEGMENT_CELLS).toBe(2)
  })

  it("drops a break too close to the end of the file", () => {
    const built = buildBoundaries(pairs, [{ index: 0 }, { index: 10 }, { index: 19 }])
    expect(built).toHaveLength(2)
    expect(built[1].endCellId).toBe("c20")
  })

  it("carries title and gist onto the passage the break opens", () => {
    const built = buildBoundaries(pairs, [
      { index: 0, title: "Opening", gist: "It begins." },
      { index: 10, title: "Turn", gist: "It shifts." },
    ])
    expect(built[0]).toMatchObject({ title: "Opening", gist: "It begins." })
    expect(built[1]).toMatchObject({ title: "Turn", gist: "It shifts." })
  })

  it("returns one whole-file segment when nothing broke", () => {
    expect(buildBoundaries(pairs, [{ index: 0 }])).toEqual([{ startCellId: "c1", endCellId: "c20" }])
  })
})

describe("segmentWithModel", () => {
  it("runs one fast-tier call for a file that fits a window", async () => {
    const { llm, calls } = scriptedLlm([
      passages({ line: 1, title: "Opening" }, { line: 11, title: "Turn" }),
    ])
    const result = await segmentWithModel({ pairs: cells(20), llm })
    expect(calls).toHaveLength(1)
    expect(calls[0].tier).toBe("fast")
    expect(calls[0].label).toBe("segment")
    expect(result.calls).toBe(1)
    expect(result.boundaries.map((b) => [b.startCellId, b.endCellId])).toEqual([
      ["c1", "c10"],
      ["c11", "c20"],
    ])
    expect(result.notes).toEqual([])
  })

  it("passes the human's note and source language into the prompt", async () => {
    const { llm, calls } = scriptedLlm([passages({ line: 1 })])
    await segmentWithModel({
      pairs: cells(10),
      llm,
      note: "keep each parable in one passage",
      sourceLanguage: "Koine Greek",
    })
    expect(calls[0].system).toContain("keep each parable in one passage")
    expect(calls[0].system).toContain("Koine Greek")
  })

  it("re-decides from the last break so a passage spanning windows is seen whole", async () => {
    const total = WINDOW_CELLS + 40
    const replies = [
      // First window: last break well inside it, so the tail is re-read.
      passages({ line: 1 }, { line: 41 }, { line: 81 }),
      // Second window starts at absolute index 80.
      passages({ line: 1 }, { line: 31 }),
    ]
    const { llm, calls } = scriptedLlm(replies)
    const result = await segmentWithModel({ pairs: cells(total), llm })
    expect(calls).toHaveLength(2)
    // Second window's user prompt must begin at the last break, not the edge.
    expect(calls[1].user).toContain(`1. source of c81`)
    expect(result.boundaries[result.boundaries.length - 1].endCellId).toBe(`c${total}`)
  })

  it("covers the whole file even when a window proposes nothing", async () => {
    const total = WINDOW_CELLS + 30
    const { llm } = scriptedLlm([passages({ line: 1 }), passages({ line: 1 }, { line: 11 })])
    const result = await segmentWithModel({ pairs: cells(total), llm })
    const first = result.boundaries[0]
    const last = result.boundaries[result.boundaries.length - 1]
    expect(first.startCellId).toBe("c1")
    expect(last.endCellId).toBe(`c${total}`)
    expect(result.notes.join(" ")).toContain("no passage breaks proposed")
  })

  it("keeps the file whole when the very first call throws", async () => {
    const llm: LlmCall = vi.fn().mockRejectedValue(new Error("upstream down"))
    const result = await segmentWithModel({ pairs: cells(30), llm })
    expect(result.boundaries).toEqual([{ startCellId: "c1", endCellId: "c30" }])
    expect(result.notes.join(" ")).toContain("call failed")
  })

  it("stops at the window cap and says what it left alone", async () => {
    // Every window proposes a break one line in, so the cursor crawls and the
    // cap is what ends the loop.
    const llm: LlmCall = async () => passages({ line: 1 }, { line: 2 })
    const result = await segmentWithModel({ pairs: cells(5000), llm })
    expect(result.calls).toBe(MAX_WINDOWS)
    expect(result.notes.join(" ")).toContain(`stopped after ${MAX_WINDOWS} windows`)
    expect(result.boundaries[result.boundaries.length - 1].endCellId).toBe("c5000")
  })

  it("reports an empty file rather than calling the model", async () => {
    const { llm, calls } = scriptedLlm([])
    const result = await segmentWithModel({ pairs: [], llm })
    expect(calls).toHaveLength(0)
    expect(result.boundaries).toEqual([])
    expect(result.notes.join(" ")).toContain("no source cells")
  })
})
