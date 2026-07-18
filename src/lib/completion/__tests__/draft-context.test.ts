import { describe, it, expect } from "vitest"
import { gatherPrecedingContext, gatherFollowingSource, DEFAULT_DRAFT_CONTEXT } from "../draft-context"

const cell = (
  id: string,
  fileId: string,
  original: string,
  translated: string,
  status = translated ? "validated" : "empty",
) => ({ id, fileId, original, translated, status })

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

  // D4 source-fallback (opt-in): before anything is committed, fall back to
  // showing the preceding SOURCE as left-context rather than nothing.
  it("with sourceFallback=true, includes uncommitted preceding cells carrying source (empty target)", () => {
    // From 'd', count 3, scanning back: c (uncommitted → fallback), b, a (committed). Doc order.
    expect(gatherPrecedingContext(cells, "d", 3, true)).toEqual([
      { source: "v1 src", target: "v1 tgt" },
      { source: "v2 src", target: "v2 tgt" },
      { source: "v3 src", target: "" },
    ])
  })

  it("sourceFallback defaults OFF — uncommitted cells are still skipped (shipped behavior unchanged)", () => {
    expect(gatherPrecedingContext(cells, "d", 3)).toEqual([
      { source: "v1 src", target: "v1 tgt" },
      { source: "v2 src", target: "v2 tgt" },
    ])
  })

  it("never uses an unapproved target as prompt context", () => {
    const withDraft = [
      cell("a", "f1", "draft source", "raw machine output", "unvalidated"),
      cell("b", "f1", "live source", ""),
    ]
    expect(gatherPrecedingContext(withDraft, "b", 3)).toEqual([])
    expect(gatherPrecedingContext(withDraft, "b", 3, true)).toEqual([
      { source: "draft source", target: "" },
    ])
  })

  it("with sourceFallback, still skips a preceding cell that has no source at all", () => {
    const withBlankSrc = [
      cell("a", "f1", "", ""),          // no source — nothing to show, even as fallback
      cell("b", "f1", "v2 src", ""),    // source present, uncommitted → fallback
      cell("d", "f1", "v4 src", "v4 tgt"),
    ]
    expect(gatherPrecedingContext(withBlankSrc, "d", 5, true)).toEqual([
      { source: "v2 src", target: "" },
    ])
  })
})

describe("gatherFollowingSource", () => {
  const cells = [
    cell("a", "f1", "v1 src", "v1 tgt"),
    cell("b", "f1", "v2 src", ""),
    cell("c", "f1", "", ""),          // no source — skipped
    cell("d", "f1", "v4 src", ""),
    cell("x", "f2", "other src", ""), // different file — not crossed
  ]

  it("returns the N cells' source immediately FOLLOWING the target, in document order", () => {
    // From 'a', forward: b (src), c (no source → skip), d (src). count 3 → [b, d].
    expect(gatherFollowingSource(cells, "a", 3)).toEqual([
      { source: "v2 src" },
      { source: "v4 src" },
    ])
  })

  it("never crosses a file boundary", () => {
    expect(gatherFollowingSource(cells, "d", 5)).toEqual([]) // next is x (f2) → stop
  })

  it("respects the count cap", () => {
    const many = Array.from({ length: 6 }, (_, i) => cell(`c${i}`, "f1", `s${i}`, ""))
    expect(gatherFollowingSource(many, "c0", 2)).toEqual([
      { source: "s1" },
      { source: "s2" },
    ])
  })

  it("returns [] for count <= 0, unknown id, or last cell in file", () => {
    expect(gatherFollowingSource(cells, "a", 0)).toEqual([])
    expect(gatherFollowingSource(cells, "nope", 3)).toEqual([])
    expect(gatherFollowingSource(cells, "x", 3)).toEqual([]) // x is last (its file)
  })
})
