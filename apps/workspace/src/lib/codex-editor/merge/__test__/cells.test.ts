import { describe, it, expect } from "vitest"
import { mergeTwoCellsUsingResolverLogic, applyEditToCell } from "../cells"
import type { CodexCell, EditHistory } from "@/lib/codex-editor/types"

function cell(extra: Partial<CodexCell> = {}): CodexCell {
  return {
    kind: 2, languageId: "scripture", value: "v",
    metadata: { id: "c1", type: "text", edits: [] },
    ...extra,
  }
}

describe("mergeTwoCellsUsingResolverLogic", () => {
  it("dedupes edits by {timestamp,editMap,value}", () => {
    const e: EditHistory = { author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "x" }
    const merged = mergeTwoCellsUsingResolverLogic(
      cell({ metadata: { id: "c1", type: "text", edits: [e] } }),
      cell({ metadata: { id: "c1", type: "text", edits: [e] } }),
    )
    expect(merged.metadata.edits).toHaveLength(1)
  })

  it("unions edits, sorted by timestamp", () => {
    const e1: EditHistory = { author: "a", timestamp: 100, type: "user-edit", editMap: ["value"], value: "x" }
    const e2: EditHistory = { author: "b", timestamp: 50, type: "user-edit", editMap: ["value"], value: "y" }
    const merged = mergeTwoCellsUsingResolverLogic(
      cell({ metadata: { id: "c1", type: "text", edits: [e1] } }),
      cell({ metadata: { id: "c1", type: "text", edits: [e2] } }),
    )
    expect(merged.metadata.edits!.map(e => e.timestamp)).toEqual([50, 100])
  })

  it("merges validatedBy across duplicate edits", () => {
    const base: EditHistory = {
      author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "x",
      validatedBy: [{ username: "alice", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }],
    }
    const other: EditHistory = {
      ...base,
      validatedBy: [{ username: "bob", creationTimestamp: 2, updatedTimestamp: 2, isDeleted: false }],
    }
    const merged = mergeTwoCellsUsingResolverLogic(
      cell({ metadata: { id: "c1", type: "text", edits: [base] } }),
      cell({ metadata: { id: "c1", type: "text", edits: [other] } }),
    )
    expect(merged.metadata.edits![0].validatedBy?.map(v => v.username).sort()).toEqual(["alice", "bob"])
  })
})

describe("applyEditToCell", () => {
  it("writes the leaf at editMap path", () => {
    const c = cell()
    applyEditToCell(c, {
      author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "new",
    })
    expect(c.value).toBe("new")
  })
  it("writes nested metadata path", () => {
    const c = cell()
    applyEditToCell(c, {
      author: "a", timestamp: 1, type: "user-edit",
      editMap: ["metadata", "data", "startTime"], value: 1.5,
    })
    expect(c.metadata.data?.startTime).toBe(1.5)
  })
})
