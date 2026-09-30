// AQU-1068 review round: removing a cell, and the ghost a removal can leave.
//
// Matthew's report (PR #483, on 3G): he asked the model to draft a translation
// and deleted a cell while it generated. The translation "jumped to the second
// last cell in the file", and there was no way to recover — the row could not
// be removed.
//
// The shape of that failure, which these tests pin down:
//   1. The draft commits for a cell that no longer has a source row. The server
//      projects the target row anyway, and `joinSourceAndTarget` puts a
//      target-only cell at the TAIL of the file. Hence "second last".
//   2. `getRemovalPlan` needed a source row, so the orphan it produced was
//      permanently unremovable. Hence "no way to recover from it".
//
// The store's job in the repair is to know that a cell was REMOVED rather than
// merely absent (so an in-flight write can drop itself), and to let a
// source-less row be taken out.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side: "source",
    targetLang: "",
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

function targetRow(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return row(cellId, {
    side: "target",
    targetLang: "",
    eventId: `target-${cellId}`,
    sourceEventId: `source-${cellId}`,
    value: `${cellId} translated`,
    ...over,
  })
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

/** a -> b -> c, each with a translation. */
const chain = () => [
  row("a", { anchorCellId: null, sequenceIndex: 0 }),
  row("b", { anchorCellId: "a", sequenceIndex: 1 }),
  row("c", { anchorCellId: "b", sequenceIndex: 2 }),
  targetRow("a"),
  targetRow("b"),
  targetRow("c"),
]

describe("CellStore.wasRemoved", () => {
  it("is false for a cell that is simply not in this file", () => {
    // The discriminator has to be narrow: `getCellView` returns null both for
    // a removed cell and for one this store never held, and a draft that
    // treated the second as the first would throw away real work.
    expect(makeStore(chain()).wasRemoved("nope")).toBe(false)
  })

  it("is true after this client removes the cell", () => {
    const store = makeStore(chain())
    store.applyOptimisticSourceRemove("b")
    expect(store.wasRemoved("b")).toBe(true)
    expect(store.wasRemoved("a")).toBe(false)
  })

  it("is true after a COLLABORATOR's removal arrives in a delta", () => {
    // A delta names every cell an event touched and carries their current
    // rows; a named cell with no row is the only signal we get that somebody
    // else deleted it.
    const store = makeStore(chain())
    store.replaceChangedRows(["b"], [])
    expect(store.wasRemoved("b")).toBe(true)
  })

  it("does not fire for a cell a delta merely UPDATED", () => {
    const store = makeStore(chain())
    store.replaceChangedRows(["b"], [row("b", { anchorCellId: "a", value: "edited" }), targetRow("b")])
    expect(store.wasRemoved("b")).toBe(false)
  })

  it("is cleared by a rollback — the row is back, so a pending write may land", () => {
    const store = makeStore(chain())
    const removed = store.applyOptimisticSourceRemove("b")
    store.rollbackOptimisticSourceChange("b", removed)
    expect(store.wasRemoved("b")).toBe(false)
  })

  it("is cleared by a file switch — another file's ids mean nothing here", () => {
    const store = makeStore(chain())
    store.applyOptimisticSourceRemove("b")
    store.reset("p", "other-file")
    expect(store.wasRemoved("b")).toBe(false)
  })
})

describe("CellStore.getRemovalPlan on a source-less row (the ghost)", () => {
  /** What the file looks like after a draft landed on a deleted cell: `b` has
   *  a translation and no source row. */
  const withGhost = () => [
    row("a", { anchorCellId: null, sequenceIndex: 0 }),
    row("c", { anchorCellId: "a", sequenceIndex: 2 }),
    targetRow("a"),
    targetRow("b"),
    targetRow("c"),
  ]

  it("returns a plan instead of null, so the row can be taken out at all", () => {
    // This returning null is what left Matthew with a row he could not remove.
    const plan = makeStore(withGhost()).getRemovalPlan("b")
    expect(plan).not.toBeNull()
    expect(plan!.sourceless).toBe(true)
  })

  it("plans NO source delete and NO re-anchor — there is no chain to mend", () => {
    const plan = makeStore(withGhost()).getRemovalPlan("b")!
    expect(plan.eventId).toBe("")
    expect(plan.successor).toBeNull()
    expect(plan.anchorCellId).toBeNull()
  })

  it("still names every lane holding a translation to delete", () => {
    const store = makeStore([
      ...withGhost(),
      targetRow("b", { targetLang: "fr", eventId: "target-b-fr" }),
    ])
    expect(store.getRemovalPlan("b")!.targetLangs.sort()).toEqual(["", "fr"])
  })

  it("returns null when there is nothing on any side", () => {
    expect(makeStore(withGhost()).getRemovalPlan("ghost-of-a-ghost")).toBeNull()
  })

  it("an ordinary removal is unaffected and still says sourceless: false", () => {
    const plan = makeStore(chain()).getRemovalPlan("b")!
    expect(plan.sourceless).toBe(false)
    expect(plan.eventId).toBe("source-b")
    expect(plan.successor).toEqual({ cellId: "c", eventId: "source-c" })
    expect(plan.anchorCellId).toBe("a")
  })

  it("still refuses a row whose insert has not been confirmed", () => {
    // The unconfirmed-insert guard is a different rule and must survive: that
    // row HAS a source, it just has no event id to chain a delete onto.
    const store = makeStore(chain())
    store.applyOptimisticSourceInsert({ cellId: "new", anchorCellId: "b", reanchorCellId: "c" })
    expect(store.getRemovalPlan("new")).toBeNull()
  })
})

describe("CellStore.applyOptimisticSourceRemove on a source-less row", () => {
  const withGhost = () => [
    row("a", { anchorCellId: null, sequenceIndex: 0 }),
    row("c", { anchorCellId: "a", sequenceIndex: 2 }),
    targetRow("a"),
    targetRow("b"),
    targetRow("c"),
  ]

  it("takes the ghost off screen", () => {
    const store = makeStore(withGhost())
    expect(store.getCellView("b")).not.toBeNull()
    expect(store.applyOptimisticSourceRemove("b")).not.toBeNull()
    expect(store.getCellView("b")).toBeNull()
  })

  it("reports no source row to restore, and leaves the real chain alone", () => {
    const store = makeStore(withGhost())
    const removed = store.applyOptimisticSourceRemove("b")!
    expect(removed.source).toBeUndefined()
    expect(removed.successorCellId).toBeNull()
    // `c` was anchored to `a` all along — a ghost is not in the chain, so
    // removing it must not re-point anything.
    expect(store.getRemovalPlan("c")!.anchorCellId).toBe("a")
  })

  it("puts the ghost back on rollback without inventing a source row", () => {
    const store = makeStore(withGhost())
    const removed = store.applyOptimisticSourceRemove("b")!
    store.rollbackOptimisticSourceChange("b", removed)
    expect(store.getCellView("b")).not.toBeNull()
    // Still source-less: a rollback restores what was there, and what was
    // there was a translation with no source.
    expect(store.getRemovalPlan("b")!.sourceless).toBe(true)
  })

  it("returns null when the cell has nothing on any side", () => {
    expect(makeStore(withGhost()).applyOptimisticSourceRemove("absent")).toBeNull()
  })
})
