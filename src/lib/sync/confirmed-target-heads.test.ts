import { describe, expect, it, vi } from "vitest"
import { confirmedTargetHeadKeys } from "./confirmed-target-heads"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellRow } from "./cells-read-types"

describe("pending target head confirmation", () => {
  it("reads only pending cells in the active lane and confirms only the exact event", () => {
    const pending = new Map([
      ["a\u0000", { eventId: "new-a" }], ["b\u0000", { eventId: "new-b" }],
      ["a\u0000fr", { eventId: "french-a" }], ["missing\u0000", { eventId: "gone" }],
    ])
    const projected = new Map([["a", "old-a"], ["b", "new-b"]])
    const read = vi.fn((id: string) => projected.get(id))
    expect(confirmedTargetHeadKeys(pending, "", read)).toEqual(["b\u0000"])
    expect(read.mock.calls).toEqual([["a"], ["b"], ["missing"]])
    expect(pending.size).toBe(4)
    read.mockClear()
    projected.set("a", "french-a")
    expect(confirmedTargetHeadKeys(pending, "fr", read)).toEqual(["a\u0000fr"])
    expect(read.mock.calls).toEqual([["a"]])
  })

  it("uses current projected event IDs from a real store, including lane switches", () => {
    const store = new CellStore()
    const ctx = { projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() }
    store.setRuntime(ctx)
    const source: CellRow = {
      cellId: "a", side: "source", value: "source", valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: "source", sourceEventId: null,
      lastEditor: "alice", lastEditAt: 1, validated: false, wordCount: 1,
    }
    const target = { ...source, side: "target" as const, value: "draft", eventId: "H" }
    store.replaceRows([source, target, { ...target, targetLang: "fr", eventId: "French" }])
    const pending = new Map([["a\u0000", { eventId: "B" }], ["a\u0000fr", { eventId: "French" }]])
    const read = (id: string) => store.getCellSummary(id)?.targetEventId
    expect(confirmedTargetHeadKeys(pending, "", read)).toEqual([])
    store.replaceRowsForCell("a", [source, { ...target, eventId: "A" }])
    expect(confirmedTargetHeadKeys(pending, "", read)).toEqual([])
    store.replaceRowsForCell("a", [source, { ...target, eventId: "B" }, { ...target, targetLang: "fr", eventId: "French" }])
    expect(confirmedTargetHeadKeys(pending, "", read)).toEqual(["a\u0000"])
    store.setRuntime({ ...ctx, lane: "fr" })
    expect(confirmedTargetHeadKeys(pending, "fr", read)).toEqual(["a\u0000fr"])
    store.reset("p", "other-file")
    expect(confirmedTargetHeadKeys(pending, "fr", read)).toEqual([])
  })
})
