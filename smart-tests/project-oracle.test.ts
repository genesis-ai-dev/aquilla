import { describe, expect, it } from "vitest"
import { cellsUnchanged, commentMatches, verifiedOutcome } from "./project-oracle"
import type { ProjectedCellRow } from "../e2e/helpers/seed-project"
import type { CommentRecord } from "../src/lib/sync/comments-read-types"

const baseRow: ProjectedCellRow = {
  cellId: "c1",
  side: "source",
  value: "v1",
  eventId: "e1",
  validated: false,
  aiDrafted: false,
}
const rowB: ProjectedCellRow = {
  ...baseRow,
  cellId: "c2",
  side: "target",
  value: "v2",
  eventId: "e2",
}
const before = [baseRow, rowB]

describe("cellsUnchanged", () => {
  it("accepts reordered identical rows", () => {
    expect(cellsUnchanged(before, [rowB, baseRow])).toBe(true)
  })

  it("rejects changed value", () => {
    const after = [baseRow, { ...rowB, value: "changed" }]
    expect(cellsUnchanged(before, after)).toBe(false)
  })

  it("rejects changed eventId", () => {
    const after = [baseRow, { ...rowB, eventId: "e3" }]
    expect(cellsUnchanged(before, after)).toBe(false)
  })

  it("rejects lost row", () => {
    expect(cellsUnchanged(before, [baseRow])).toBe(false)
  })

  it("rejects duplicate row", () => {
    expect(cellsUnchanged(before, [baseRow, rowB, rowB])).toBe(false)
  })

  it("rejects changed side", () => {
    const after: ProjectedCellRow[] = [baseRow, { ...rowB, side: "source" }]
    expect(cellsUnchanged(before, after)).toBe(false)
  })

  it("rejects changed cellId", () => {
    const after = [baseRow, { ...rowB, cellId: "c3" }]
    expect(cellsUnchanged(before, after)).toBe(false)
  })
})

describe("comment contract", () => {
  const contract = { body: "Review this", projectId: "project", fileId: "file", cellId: "cell" }
  const comment: CommentRecord = { ...contract, commentId: "comment", scopeKind: "cell",
    parentCommentId: null, deletedAt: null, resolved: false,
    authorId: "alice", authorLabel: "Alice", createdAt: 1, updatedAt: 1 }
  it("accepts exactly one root comment on the intended cell", () => {
    expect(commentMatches([comment], contract)).toBe(true)
  })
  it("rejects missing and duplicate writes", () => {
    expect(commentMatches([], contract)).toBe(false)
    expect(commentMatches([comment, comment], contract)).toBe(false)
  })
  for (const patch of [{ cellId: "wrong" }, { fileId: "wrong" }, { projectId: "wrong" },
    { body: "wrong" }, { parentCommentId: "other" }, { deletedAt: 10 }, { resolved: true }]) {
    it(`rejects ${JSON.stringify(patch)}`, () => {
      expect(commentMatches([{ ...comment, ...patch }], contract)).toBe(false)
    })
  }
})

describe("verifiedOutcome", () => {
  it("passes with nonempty all-true checks and observed input", () => {
    const outcome = verifiedOutcome({ a: true, b: true }, true)
    expect(outcome.verdict).toBe("passed")
    expect(outcome.checks).toEqual({ a: true, b: true, inputObserved: true })
  })

  it("is inconclusive when input is unobserved even if checks are all true", () => {
    const outcome = verifiedOutcome({ a: true, b: true }, false)
    expect(outcome.verdict).toBe("inconclusive")
  })

  it("is product_failure when any check is false and input is observed", () => {
    const outcome = verifiedOutcome({ a: true, b: false }, true)
    expect(outcome.verdict).toBe("product_failure")
  })

  it("is inconclusive when any check is false and input is unobserved", () => {
    const outcome = verifiedOutcome({ a: true, b: false }, false)
    expect(outcome.verdict).toBe("inconclusive")
  })

  it("cannot pass with empty checks even when input is observed", () => {
    const outcome = verifiedOutcome({}, true)
    expect(outcome.verdict).toBe("product_failure")
  })

  it("is inconclusive with empty checks and unobserved input", () => {
    const outcome = verifiedOutcome({}, false)
    expect(outcome.verdict).toBe("inconclusive")
  })
})
