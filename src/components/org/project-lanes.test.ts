// AQU-605 — optimistic in-place lane insert for the org project table.
// Adding a language must update just that project's row (a new chip) instead of
// blanking the whole table on a portfolio refetch. `withOptimisticLane` is the
// pure state transform behind that behaviour.

import { describe, it, expect } from "vitest"
import type { PortfolioProject } from "@/lib/frontier/portfolio"
import { displayLanes, withOptimisticLane } from "./project-lanes"

function baseProject(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: "p",
    name: "Project",
    totalCells: 100,
    validatedCells: 0,
    filledCells: 0,
    aiDraftedCells: 0,
    lastEditAt: null,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: null,
    ...overrides,
  }
}

describe("withOptimisticLane (AQU-605)", () => {
  it("appends the new lane as a chip while keeping the default lane", () => {
    const p = baseProject()
    const next = withOptimisticLane(p, "fr-CA")
    const laneNames = displayLanes(next).map((l) => l.lane)
    // Default ('') lane retained + the new named lane appears in place.
    expect(laneNames).toEqual(["", "fr-CA"])
  })

  it("appends to an existing server-provided lane breakdown", () => {
    const p = baseProject({
      lanes: [
        { lane: "", totalCells: 100, filledCells: 40, validatedCells: 10, lastEditAt: 1 },
        { lane: "es", totalCells: 100, filledCells: 5, validatedCells: 0, lastEditAt: 2 },
      ],
    })
    const next = withOptimisticLane(p, "fr")
    expect(displayLanes(next).map((l) => l.lane)).toEqual(["", "es", "fr"])
    // The optimistic lane starts empty — real rollups arrive on the next load.
    const added = next.lanes?.find((l) => l.lane === "fr")
    expect(added).toEqual({
      lane: "fr",
      totalCells: 0,
      filledCells: 0,
      validatedCells: 0,
      lastEditAt: null,
    })
  })

  it("is a no-op for a case-insensitive duplicate", () => {
    const p = baseProject({
      lanes: [
        { lane: "", totalCells: 100, filledCells: 0, validatedCells: 0, lastEditAt: null },
        { lane: "fr", totalCells: 100, filledCells: 0, validatedCells: 0, lastEditAt: null },
      ],
    })
    expect(withOptimisticLane(p, "FR")).toBe(p)
  })

  it("trims and ignores a blank tag", () => {
    const p = baseProject()
    expect(withOptimisticLane(p, "   ")).toBe(p)
    expect(displayLanes(withOptimisticLane(p, "  de  ")).map((l) => l.lane)).toEqual(["", "de"])
  })

  it("does not mutate the input project", () => {
    const p = baseProject()
    const next = withOptimisticLane(p, "fr")
    expect(p.lanes).toBeUndefined()
    expect(next).not.toBe(p)
  })
})
