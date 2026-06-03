import { describe, it, expect } from "vitest"
import { orderedByForFileType, buildBulkCellsWithSpeakers } from "./import"
import type { TranslatableString } from "./parsers/types"

// WHY: subtitle imports must become TIME-ordered (their cues are the timeline
// spine) while every text/document format stays SEQUENCE-ordered. And every
// imported cell must carry an intrinsic sequenceIndex so the order lens has a
// stable key / home for untimed rows. Regressions here silently break the
// editor's layer switch (it's gated on orderedBy==='time').

describe("orderedByForFileType", () => {
  it("marks subtitle formats as time-ordered", () => {
    expect(orderedByForFileType("vtt")).toBe("time")
    expect(orderedByForFileType("srt")).toBe("time")
  })
  it("leaves text/document formats sequence-ordered", () => {
    for (const t of ["usfm", "ebible", "docx", "txt", "csv"] as const) {
      expect(orderedByForFileType(t)).toBe("sequence")
    }
  })
})

describe("buildBulkCellsWithSpeakers — sequenceIndex", () => {
  it("assigns a 0-based intrinsic order to every cell, in input order", () => {
    const strings: TranslatableString[] = [
      { id: "", original: "one", translated: "", context: "", group: "", type: "cue", start: 1, end: 2 },
      { id: "", original: "two", translated: "", context: "", group: "", type: "cue", start: 3, end: 4 },
      { id: "", original: "three", translated: "", context: "", group: "", type: "cue" },
    ]
    const { cells } = buildBulkCellsWithSpeakers(strings)
    expect(cells.map((c) => c.sequenceIndex)).toEqual([0, 1, 2])
    // Untimed third cell still gets an order key (no fake timecodes).
    expect(cells[2].startMs).toBeUndefined()
    expect(cells[2].sequenceIndex).toBe(2)
  })
})
