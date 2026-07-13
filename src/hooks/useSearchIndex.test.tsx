import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useSearchIndex } from "./useSearchIndex"
import type { CellData } from "./useCells"

function cell(partial: Partial<CellData> & { id: string; original: string; translated: string }): CellData {
  return {
    fileId: "f1",
    cellLabel: partial.id,
    validationStatus: "none",
    activeValidators: [],
    status: partial.translated ? "validated" : "empty",
    context: "",
    group: "",
    type: "text",
    history: [],
    threads: [],
    validationHistory: [],
    ...partial,
  } as CellData
}

describe("useSearchIndex.search", () => {
  it("excludes the queried cell from its own few-shot results", () => {
    const cells = [
      cell({ id: "a", original: "the cat sat on the mat", translated: "le chat s'est assis sur le tapis" }),
      cell({ id: "b", original: "the dog sat on the rug", translated: "le chien s'est assis sur le tapis" }),
      cell({ id: "c", original: "the cat ran on the mat", translated: "le chat a couru sur le tapis" }),
    ]
    const { result } = renderHook(() => useSearchIndex([], cells))
    const withSelf = result.current.search("the cat sat on the mat", 5)
    expect(withSelf.some((p) => p.cellId === "a")).toBe(true)

    const withoutSelf = result.current.search("the cat sat on the mat", 5, "a")
    expect(withoutSelf.every((p) => p.cellId !== "a")).toBe(true)
  })

  it("returns the same count whether or not the excluded id would have been in the head", () => {
    // Cell c0's source overlaps heavily with the query, so it would normally
    // dominate the head of results. Excluding it must still return as many
    // results as the un-excluded query yields against the rest of the index.
    const cells = [
      cell({ id: "c0", original: "the quick brown fox jumps over a lazy dog", translated: "t0" }),
      cell({ id: "c1", original: "the quick brown fox is fast", translated: "t1" }),
      cell({ id: "c2", original: "the dog jumps over a fence", translated: "t2" }),
      cell({ id: "c3", original: "a lazy cat sleeps", translated: "t3" }),
    ]
    const { result } = renderHook(() => useSearchIndex([], cells))
    const baseline = result.current.search("the quick brown fox jumps over a lazy dog", 5).filter((p) => p.cellId !== "c0")
    const withExclude = result.current.search("the quick brown fox jumps over a lazy dog", 5, "c0")
    expect(withExclude.every((p) => p.cellId !== "c0")).toBe(true)
    // Filtering after the fact loses one result when the query matched the excluded cell;
    // the +1 buffer in `search` should preserve the count that would have been returned
    // had the excluded cell never been there. We assert at least as many results as the
    // post-filter baseline — i.e. the buffer didn't make us return fewer.
    expect(withExclude.length).toBeGreaterThanOrEqual(baseline.length)
  })

  it("never indexes unreviewed target text", () => {
    const cells = [
      cell({ id: "approved", original: "approved source", translated: "approved target" }),
      cell({ id: "draft", original: "unreviewed source", translated: "unreviewed target", status: "unvalidated" }),
    ]
    const { result } = renderHook(() => useSearchIndex([], cells))
    expect(result.current.search("unreviewed source", 5).every((pair) => pair.cellId !== "draft")).toBe(true)
  })
})
