import { describe, it, expect } from "vitest"
import { droppedPinnedCells, type PendingCommitHead } from "./pending-commit-pin"

function pinMap(entries: Array<[string, PendingCommitHead]>): Map<string, PendingCommitHead> {
  return new Map(entries)
}

describe("droppedPinnedCells (AQU-668)", () => {
  it("returns the cell whose pinned head was dropped as a stale sibling", () => {
    const pins = pinMap([
      ["cellA", { eventId: "evtL", parentId: "P" }],
      ["cellB", { eventId: "evtX", parentId: "Q" }],
    ])
    expect(droppedPinnedCells(pins, ["evtL"])).toEqual(["cellA"])
  })

  it("matches by dropped EVENT id, not cell id — a pin re-established for a newer commit survives", () => {
    // cellA's dropped commit was evtL, but a newer edit already re-pinned evtL2.
    // The stale-drop notice for evtL must NOT clear the fresh pin.
    const pins = pinMap([["cellA", { eventId: "evtL2", parentId: "P" }]])
    expect(droppedPinnedCells(pins, ["evtL"])).toEqual([])
  })

  it("clears every cell hit by a multi-cell drop batch", () => {
    const pins = pinMap([
      ["cellA", { eventId: "e1", parentId: null }],
      ["cellB", { eventId: "e2", parentId: null }],
      ["cellC", { eventId: "e3", parentId: null }],
    ])
    expect(droppedPinnedCells(pins, ["e1", "e3"]).sort()).toEqual(["cellA", "cellC"])
  })

  it("is a no-op when nothing was dropped (the ordinary single-editor case)", () => {
    const pins = pinMap([["cellA", { eventId: "e1", parentId: "P" }]])
    expect(droppedPinnedCells(pins, [])).toEqual([])
  })

  it("returns nothing when the drop is for a cell that was never pinned", () => {
    const pins = pinMap([["cellA", { eventId: "e1", parentId: "P" }]])
    expect(droppedPinnedCells(pins, ["some-other-event"])).toEqual([])
  })
})
