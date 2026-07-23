import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, side: "source" | "target", value: string, eventId: string): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: side === "source" ? "GEN 1:1" : null,
    anchorCellId: null,
    eventId,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
  }
}

function makeStore(): CellStore {
  const store = new CellStore()
  store.reset("project", "file")
  store.setRuntime({
    projectId: "project",
    fileId: "file",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(
    [row("c1", "source", "one", "src-c1"), row("c1", "target", "old", "t-P")],
    { full: true },
  )
  return store
}

describe("CellStore.discardOptimisticEdit (AQU-668)", () => {
  it("un-protects a cell so a winning sibling can land after its own commit was dropped", () => {
    const store = makeStore()

    // Local optimistic edit whose commit will be dropped as a stale sibling.
    store.applyOptimisticTargetEdit("c1", { value: "mine" })

    // A refetch brings the WINNING sibling (a different account's edit that
    // claimed the chain slot). While the optimistic shadow is live, the cell is
    // "protected": the merge keeps the LOCAL row (still at the stale head t-P)
    // and discards the winner — this is what pins the projected head at the
    // dropped commit's parent and turns the cell into a black hole for edits.
    const winner = [row("c1", "source", "one", "src-c1"), row("c1", "target", "winner", "t-W")]
    const protectedMerge = store.mergeProtectedRows(winner, /* fetchStartSeq */ 0)
    expect(protectedMerge.discardedCellIds.has("c1")).toBe(true)
    const protectedTarget = protectedMerge.rows.find((r) => r.cellId === "c1" && r.side === "target")
    expect(protectedTarget?.eventId).toBe("t-P") // winner was discarded — head stuck at parent

    // The fix: discard the unconfirmed shadow (and its freshness floor) when the
    // commit is dropped. Now the same refetch is NOT protected, so the winner
    // lands and the projected head advances — the next edit can chain onto it.
    expect(store.discardOptimisticEdit("c1")).toBe(true)
    const healedMerge = store.mergeProtectedRows(winner, /* fetchStartSeq */ 0)
    expect(healedMerge.discardedCellIds.has("c1")).toBe(false)
    const healedTarget = healedMerge.rows.find((r) => r.cellId === "c1" && r.side === "target")
    expect(healedTarget?.eventId).toBe("t-W")
  })

  it("drops the ghost text overlay so a revalidated winner replaces the lost edit", () => {
    const store = makeStore()
    store.applyOptimisticTargetEdit("c1", { value: "mine" })
    expect(store.getCellView("c1")?.translated).toBe("mine")

    // A targeted revalidate replaces the base row with the winner, but the
    // optimistic overlay still paints the ghost ("mine") on top of it — the
    // symptom of "text appears to save, then isn't there later".
    const winner = [row("c1", "source", "one", "src-c1"), row("c1", "target", "winner", "t-W")]
    store.replaceRowsForCell("c1", winner)
    expect(store.getCellView("c1")?.translated).toBe("mine")

    // Discarding the shadow lets the winner's text surface immediately.
    store.discardOptimisticEdit("c1")
    expect(store.getCellView("c1")?.translated).toBe("winner")
  })

  it("returns false when there was no optimistic shadow to discard", () => {
    const store = makeStore()
    expect(store.discardOptimisticEdit("c1")).toBe(false)
  })
})
