import { describe, it, expect } from "vitest"
import { resolveBtTargetEventId } from "./bt-auto"

// FRO-203 regression: a back-translation must be pinned to the event id of the
// commit whose text it describes, not to the cell's currently-projected head.
//
// The trap: `applyOptimisticTargetEdit` updates the row's text but NOT its
// `event_id`, so for a full server round-trip after a commit the cells
// projection still reports the PRE-commit head (E0). The just-committed event
// id (E1) is known only to the editor row that emitted it. If the BT pins E0,
// it becomes permanently stale the instant the projection advances to E1 —
// surfacing as a false "Stale — translation has changed" badge in the row
// detail every time, even though nothing changed.
describe("resolveBtTargetEventId — stale-BT pin", () => {
  it("pins to the just-committed event id, not the lagging projection head", () => {
    expect(resolveBtTargetEventId("E1", "E0")).toBe("E1")
  })

  it("falls back to the projected head when no commit id is known (manual Generate)", () => {
    // The Generate/Refresh button path has no in-flight commit; the cell's
    // projected targetEventId is already the current head and correct.
    expect(resolveBtTargetEventId(undefined, "E5")).toBe("E5")
  })

  it("returns empty string when neither id is known", () => {
    expect(resolveBtTargetEventId(undefined, undefined)).toBe("")
  })

  it("ignores an empty committed id and uses the projected head", () => {
    expect(resolveBtTargetEventId("", "E2")).toBe("E2")
  })
})
