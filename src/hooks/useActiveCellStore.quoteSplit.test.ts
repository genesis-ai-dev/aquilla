// AQU-1759: a split at quotes shows on the same tick, and a refused one goes
// back exactly — including a row that is both split itself and the follower of
// another split row, which the batch touches twice.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side: "source",
    value: cellId.toUpperCase(),
    valueHtml: null,
    type: "verse",
    canonicalRef: null,
    anchorCellId: null,
    eventId: `source-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    endorsementCount: 0,
    ...over,
  } as CellRow
}

function makeStore(): CellStore {
  const store = new CellStore()
  store.reset("p", "f")
  store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows([
    row("a", { sequenceIndex: 0 }),
    row("b", { anchorCellId: "a", sequenceIndex: 1, value: "B said, “hi.”" }),
    row("c", { anchorCellId: "b", sequenceIndex: 2, value: "C said, “bye.”" }),
    row("d", { anchorCellId: "c", sequenceIndex: 3 }),
  ], { full: true })
  return store
}

describe("CellStore.applyOptimisticQuoteSplit", () => {
  it("shows the pieces in place, and a rollback puts every row back", () => {
    const store = makeStore()
    const undo = store.applyOptimisticQuoteSplit([
      { cellId: "b", firstText: "B said,", pieces: [{ cellId: "b2", value: "“hi.”", sequenceIndex: 1.5 }], successorCellId: "c" },
      { cellId: "c", firstText: "C said,", pieces: [{ cellId: "c2", value: "“bye.”", sequenceIndex: 2.5 }], successorCellId: "d" },
    ])

    expect(store.getRange(0, 10).map((cell) => [cell.id, cell.original])).toEqual([
      ["a", "A"],
      ["b", "B said,"],
      ["b2", "“hi.”"],
      ["c", "C said,"],
      ["c2", "“bye.”"],
      ["d", "D"],
    ])
    // The insert plan reads the chain: c now follows b's last piece.
    expect(store.getInsertPlan("b2", "below")?.reanchor?.cellId).toBe("c")
    expect(store.getCellView("b2")?.metadata?.aquillaOrigin).toMatchObject({ kind: "user-insert", splitFrom: "b" })

    store.rollbackOptimisticQuoteSplit(undo)
    expect(store.getRange(0, 10).map((cell) => [cell.id, cell.original])).toEqual([
      ["a", "A"],
      ["b", "B said, “hi.”"],
      ["c", "C said, “bye.”"],
      ["d", "D"],
    ])
    // c was touched twice (moved onto b2, then split); it comes back as it was.
    expect(store.getInsertPlan("b", "below")?.reanchor?.cellId).toBe("c")
  })
})
