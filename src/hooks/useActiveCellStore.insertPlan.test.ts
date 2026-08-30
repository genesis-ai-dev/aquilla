// AQU-1068: inserting a cell into a file with no clock.
//
// The timed insert picks its neighbours by TIME, because on a subtitle file the
// clock is what the user is looking at. An ordinary text file has no clock, so
// the anchor chain IS the order and getInsertPlan reads it directly.
//
// The re-anchor half is the part worth pinning down. Leaving it out puts two
// rows on one anchor, and walkAnchorChain breaks that tie by event id — a fresh
// uuidv7 always sorts last, so the new cell lands at the TAIL of the file
// instead of where it was asked for. On a head insert the same omission gives
// the file two rows claiming a null anchor.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side: "source",
    value: cellId.toUpperCase(),
    valueHtml: null,
    type: null,
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

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.reset("p", "f")
  store.setRuntime({
    projectId: "p",
    fileId: "f",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true })
  return store
}

/** a -> b -> c, an untimed text file with no startMs anywhere. */
const chain = () => [
  row("a", { anchorCellId: null, sequenceIndex: 0 }),
  row("b", { anchorCellId: "a", sequenceIndex: 1 }),
  row("c", { anchorCellId: "b", sequenceIndex: 2 }),
]

describe("CellStore.getInsertPlan", () => {
  it("inserting BELOW anchors to that cell and re-points its former successor", () => {
    const plan = makeStore(chain()).getInsertPlan("b", "below")!
    expect(plan.anchorCellId).toBe("b")
    expect(plan.reanchor).toEqual({ cellId: "c", eventId: "source-c" })
    expect(plan.sequenceBefore).toBe(1)
    expect(plan.sequenceAfter).toBe(2)
  })

  it("inserting ABOVE takes that cell's anchor and re-points the cell itself", () => {
    const plan = makeStore(chain()).getInsertPlan("b", "above")!
    expect(plan.anchorCellId).toBe("a")
    expect(plan.reanchor).toEqual({ cellId: "b", eventId: "source-b" })
    expect(plan.sequenceBefore).toBe(0)
    expect(plan.sequenceAfter).toBe(1)
  })

  it("inserting ABOVE THE HEAD takes a null anchor and re-points the old head", () => {
    // The re-point is not optional here: without it the file has two rows
    // claiming a null anchor, which is the bug getChainHeadCellId documents.
    const plan = makeStore(chain()).getInsertPlan("a", "above")!
    expect(plan.anchorCellId).toBeNull()
    expect(plan.reanchor).toEqual({ cellId: "a", eventId: "source-a" })
    expect(plan.sequenceBefore).toBeUndefined()
    expect(plan.sequenceAfter).toBe(0)
  })

  it("inserting BELOW THE LAST cell has nothing to re-point", () => {
    const plan = makeStore(chain()).getInsertPlan("c", "below")!
    expect(plan.anchorCellId).toBe("c")
    expect(plan.reanchor).toBeNull()
    expect(plan.sequenceBefore).toBe(2)
    expect(plan.sequenceAfter).toBeUndefined()
  })

  it("returns null for a cell the store does not hold", () => {
    expect(makeStore(chain()).getInsertPlan("nope", "below")).toBeNull()
  })

  it("works on a single-cell file, in both directions", () => {
    const store = makeStore([row("only", { anchorCellId: null, sequenceIndex: 0 })])
    const below = store.getInsertPlan("only", "below")!
    expect(below.anchorCellId).toBe("only")
    expect(below.reanchor).toBeNull()

    const above = store.getInsertPlan("only", "above")!
    expect(above.anchorCellId).toBeNull()
    expect(above.reanchor).toEqual({ cellId: "only", eventId: "source-only" })
  })
})
