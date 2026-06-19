import { describe, it, expect } from "vitest"
import { gatherPrecedingContext, DEFAULT_DRAFT_CONTEXT } from "../draft-context"

const cell = (id: string, fileId: string, original: string, translated: string) =>
  ({ id, fileId, original, translated })

describe("gatherPrecedingContext", () => {
  const cells = [
    cell("a", "f1", "v1 src", "v1 tgt"),
    cell("b", "f1", "v2 src", "v2 tgt"),
    cell("c", "f1", "v3 src", ""),        // uncommitted — skipped
    cell("d", "f1", "v4 src", "v4 tgt"),
    cell("x", "f2", "other", "other tgt"), // different file — ignored
  ]

  it("returns the N committed cells immediately preceding the target, in document order", () => {
    const out = gatherPrecedingContext(cells, "d", 3)
    // 'c' has no target and is skipped; preceding committed are a, b (doc order)
    expect(out).toEqual([
      { source: "v1 src", target: "v1 tgt" },
      { source: "v2 src", target: "v2 tgt" },
    ])
  })

  it("never crosses a file boundary (excludes a preceding cell from another file)", () => {
    const mixed = [
      cell("x", "f2", "other src", "other tgt"), // different file, precedes target
      cell("a", "f1", "v1 src", "v1 tgt"),
      cell("b", "f1", "v2 src", "v2 tgt"),
    ]
    // going back from b: include a (f1), then hit x (f2) and stop — x excluded
    expect(gatherPrecedingContext(mixed, "b", 5)).toEqual([
      { source: "v1 src", target: "v1 tgt" },
    ])
    // nothing precedes the first f1 cell
    expect(gatherPrecedingContext(mixed, "a", 5)).toEqual([])
  })

  it("respects the count cap (most recent first-in-order)", () => {
    const many = Array.from({ length: 6 }, (_, i) => cell(`c${i}`, "f1", `s${i}`, `t${i}`))
    const out = gatherPrecedingContext(many, "c5", 2)
    expect(out).toEqual([
      { source: "s3", target: "t3" },
      { source: "s4", target: "t4" },
    ])
  })

  it("returns [] for count <= 0 or unknown cellId", () => {
    expect(gatherPrecedingContext(cells, "d", 0)).toEqual([])
    expect(gatherPrecedingContext(cells, "nope", 3)).toEqual([])
  })

  it("ships a sane default budget", () => {
    expect(DEFAULT_DRAFT_CONTEXT.precedingTargetCells).toBe(3)
  })
})
