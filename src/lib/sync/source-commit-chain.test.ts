import { describe, it, expect } from "vitest"
import {
  resolveSourceCommitParent,
  reconcilePendingSourceCommit,
} from "./source-commit-chain"

describe("resolveSourceCommitParent", () => {
  it("chains onto the locally-pending head when a commit is in flight", () => {
    expect(
      resolveSourceCommitParent({ eventId: "e1", parentId: "s0" }, "s0"),
    ).toBe("e1")
  })

  it("falls back to the projection source head when nothing is pending", () => {
    expect(resolveSourceCommitParent(null, "s0")).toBe("s0")
  })

  it("is genesis (null) when neither pending nor projection head is known", () => {
    expect(resolveSourceCommitParent(null, null)).toBe(null)
  })
})

describe("reconcilePendingSourceCommit", () => {
  it("clears the pending head once the projection catches up to it", () => {
    expect(
      reconcilePendingSourceCommit({ eventId: "e1", parentId: "s0" }, "e1"),
    ).toBe(null)
  })

  it("clears the pending head when a different/remote head lands (not our parent)", () => {
    // A peer lead or mirror-sync advanced the source head past what we chained
    // from — the next edit should chain onto that newer projection head.
    expect(
      reconcilePendingSourceCommit({ eventId: "e1", parentId: "s0" }, "remote-head"),
    ).toBe(null)
  })

  it("KEEPS the pending head while the projection still lags at our commit's parent", () => {
    // AQU-603 regression: a lane switch triggers a cells revalidate that lands
    // before our source.cell.commit projects, so the projection head is still
    // the parent we chained from. The pending head must NOT be regressed —
    // otherwise the next edit forks a second commit onto the same parent and the
    // server drops it as a "stale sibling" (accepted but not applied).
    const pending = { eventId: "e1", parentId: "s0" }
    expect(reconcilePendingSourceCommit(pending, "s0")).toBe(pending)
  })

  it("full sequence: two rapid source edits across a lagging revalidate chain correctly", () => {
    // Edit 1: projection head is s0, nothing pending yet.
    let pending = reconcilePendingSourceCommit(null, "s0")
    const parent1 = resolveSourceCommitParent(pending, "s0")
    expect(parent1).toBe("s0")
    // ...commit e1 enqueued, chained on s0.
    pending = { eventId: "e1", parentId: parent1 }

    // A lane switch revalidates cells; e1 hasn't projected, head is still s0.
    pending = reconcilePendingSourceCommit(pending, "s0")
    expect(pending).toEqual({ eventId: "e1", parentId: "s0" })

    // Edit 2 must chain onto e1, NOT re-use s0 (which would fork a stale sibling).
    const parent2 = resolveSourceCommitParent(pending, "s0")
    expect(parent2).toBe("e1")
  })

  it("returns null unchanged when there is no pending commit", () => {
    expect(reconcilePendingSourceCommit(null, "s0")).toBe(null)
    expect(reconcilePendingSourceCommit(null, null)).toBe(null)
  })
})
