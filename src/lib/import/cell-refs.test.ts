import { describe, expect, it } from "vitest"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { fileTargetCellRef } from "./cell-refs"
import { matchTargetRowsByOrder, vttToTargetRows } from "../import-file-target"

describe("file target import cell references", () => {
  it("matches real store summaries to VTT milliseconds even when incoming cues are reordered", () => {
    const store = new CellStore()
    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() })
    const source: CellRow = {
      cellId: "a", side: "source", value: "First", valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: "src-a", sourceEventId: null,
      lastEditor: "alice", lastEditAt: 1, validated: false, wordCount: 1,
      startMs: 1000, endMs: 2000,
    }
    store.replaceRows([source, {
      ...source, cellId: "b", value: "Second", anchorCellId: "a", eventId: "src-b", startMs: 10000, endMs: 11000,
    }])
    const refs = store.getAllSummaries().map(fileTargetCellRef)
    expect(refs.map(ref => [ref.startMs, ref.endMs])).toEqual([[1000, 2000], [10000, 11000]])
    const incoming = vttToTargetRows("WEBVTT\n\n00:00:10.000 --> 00:00:11.000\nDeux\n\n00:00:01.000 --> 00:00:02.000\nUn\n")
    const match = matchTargetRowsByOrder(incoming, refs)
    expect(match.alignedBy).toBe("overlap")
    expect(match.orphans).toEqual([])
    expect(match.matched.find(cell => cell.cellId === "a"))
      .toMatchObject({ incomingText: "Un", parentId: "src-a", sourceText: "First" })
    expect(match.matched.find(cell => cell.cellId === "b"))
      .toMatchObject({ incomingText: "Deux", parentId: "src-b", sourceText: "Second" })

    store.replaceRows([{ ...source, startMs: undefined, endMs: undefined }])
    expect(fileTargetCellRef(store.getAllSummaries()[0])).not.toHaveProperty("startMs")
  })
})
