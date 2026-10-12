import { describe, expect, it } from "vitest"
import { firstEventId, resolveTargetCommitParent } from "./target-commit-parent"

describe("resolveTargetCommitParent (AQU-1578)", () => {
  it("prefers the reserved pending head over the projection", () => {
    expect(resolveTargetCommitParent({
      pending: ["E-reserved"],
      targetEventId: "E-projected",
      sourceEventId: "S",
    })).toBe("E-reserved")
  })

  it("walks pending heads in priority order", () => {
    expect(resolveTargetCommitParent({
      pending: [null, undefined, "", "E-completion"],
      targetEventId: "E-projected",
    })).toBe("E-completion")
  })

  it("treats the optimistic placeholder '' as absent and falls back to the source head", () => {
    expect(resolveTargetCommitParent({
      pending: [null],
      targetEventId: "",
      sourceEventId: "S",
    })).toBe("S")
  })

  it("uses the projected target head when nothing is pending", () => {
    expect(resolveTargetCommitParent({ targetEventId: "E-projected", sourceEventId: "S" }))
      .toBe("E-projected")
  })

  it("never returns '' — null when no head is known", () => {
    expect(resolveTargetCommitParent({ pending: [""], targetEventId: "", sourceEventId: "" }))
      .toBeNull()
    expect(resolveTargetCommitParent({})).toBeNull()
  })
})

describe("firstEventId", () => {
  it("skips null, undefined and empty strings", () => {
    expect(firstEventId(undefined, "", null, "E1", "E2")).toBe("E1")
    expect(firstEventId("", null)).toBeNull()
  })
})
