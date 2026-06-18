import { describe, it, expect } from "vitest"
import { resolveBtTargetEventId, shouldAutoRecomputeBt } from "./bt-auto"

// FRO-203 regression: a back-translation produced automatically right after a
// `target.cell.commit` must be pinned to the event id of THAT commit (the text
// it describes), not to the cell's currently-projected head.
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

  it("falls back to the projected head when no commit id is known (manual Generate/Polish)", () => {
    // The Generate/Regenerate/Polish button path has no in-flight commit; the
    // cell's projected targetEventId is already the current head and correct.
    expect(resolveBtTargetEventId(undefined, "E5")).toBe("E5")
  })

  it("returns empty string when neither id is known", () => {
    expect(resolveBtTargetEventId(undefined, undefined)).toBe("")
  })

  it("ignores an empty committed id and uses the projected head", () => {
    expect(resolveBtTargetEventId("", "E2")).toBe("E2")
  })
})

describe("shouldAutoRecomputeBt", () => {
  it("recomputes when there is no cached BT", () => {
    expect(shouldAutoRecomputeBt("hello world", undefined)).toBe(true)
  })

  it("does not recompute for empty translated text", () => {
    expect(shouldAutoRecomputeBt("  ", "anything")).toBe(false)
  })
})
