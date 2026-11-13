import { describe, expect, it } from "vitest"
import { piecesApproved, takeBadgeState } from "./audio-validation-state"

describe("takeBadgeState", () => {
  it("is a single check for your own vote below the threshold", () => {
    expect(takeBadgeState({ validatorCount: 1, validators: ["sam"] }, "sam", 2)).toBe("self")
  })

  it("is a double check once the threshold is met", () => {
    expect(takeBadgeState({ validatorCount: 1, validators: ["ana"] }, "sam", 1)).toBe("full")
  })

  it("reads missing counts as no votes", () => {
    expect(takeBadgeState({}, "sam", 1)).toBe("none")
  })

  it("never ticks an imported source clip", () => {
    expect(takeBadgeState({ role: "source", validatorCount: 3, validators: ["sam"] }, "sam", 1)).toBeNull()
  })
})

// Decision 7 (Sam, 2026-10-22): a cut take says how many of its pieces are
// approved, each against the project's requirement.
describe("piecesApproved", () => {
  const piece = (validatorCount: number) => ({ validatorCount })

  it("counts a piece only once its own votes reach the requirement", () => {
    expect(piecesApproved([piece(2), piece(2), piece(1)], 2)).toEqual({ approved: 2, total: 3 })
    expect(piecesApproved([piece(2), piece(2), piece(2)], 2)).toEqual({ approved: 3, total: 3 })
  })

  it("needs one vote even when the requirement is zero", () => {
    expect(piecesApproved([piece(0), piece(1)], 0)).toEqual({ approved: 1, total: 2 })
  })

  it("is nothing for no pieces", () => {
    expect(piecesApproved([], 1)).toBeNull()
  })
})
