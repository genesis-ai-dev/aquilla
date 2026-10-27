import { describe, expect, it } from "vitest"
import { openTargetLaneCount } from "./open-target-lanes"

describe("openTargetLaneCount", () => {
  it("counts live target lanes and ignores archived ones", () => {
    expect(openTargetLaneCount({
      lanes: [
        { role: "source", archivedAt: null },
        { role: "target", archivedAt: null },
        { role: "target", archivedAt: "2026-01-01" },
        { role: "target", archivedAt: null },
      ],
    })).toBe(2)
    expect(openTargetLaneCount({ targetLanes: ["ar"], archivedLanes: [] })).toBe(2)
    expect(openTargetLaneCount({ targetLanes: ["ar"], archivedLanes: ["ar"] })).toBe(1)
    expect(openTargetLaneCount({})).toBe(1)
  })
})
