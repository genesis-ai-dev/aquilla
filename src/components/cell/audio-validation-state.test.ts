import { describe, expect, it } from "vitest"
import { takeBadgeState } from "./audio-validation-state"

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
