// AQU-605 — optimistic in-place lane insert for the org project table.
// Adding a language must update just that project's row (a new chip) instead of
// blanking the whole table on a portfolio refetch. `withOptimisticLane` is the
// pure state transform behind that behaviour.

import { describe, it, expect } from "vitest"
import type { PortfolioProject } from "@/lib/frontier/portfolio"
import { displayLanes, laneChipLabel, resolveDefaultLaneLabel, withOptimisticLane } from "./project-lanes"

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

describe("resolveDefaultLaneLabel (AQU-606)", () => {
  it("labels a migrated project's default lane with the project-level target language", () => {
    // The exact regression: the lanes migration leaves the project's target on
    // project settings and its files with no per-file hint, so hint-only
    // resolution rendered the generic "Default" placeholder instead of "French".
    const p = baseProject({ targetLanguage: "French" })
    expect(resolveDefaultLaneLabel(p, undefined)).toBe("French")
    expect(laneChipLabel("", resolveDefaultLaneLabel(p, undefined))).toBe("French")
  })

  it("prefers the project-level target language over a stale per-file hint", () => {
    const p = baseProject({ targetLanguage: "French" })
    expect(resolveDefaultLaneLabel(p, "Spanish")).toBe("French")
  })

  it("falls back to the per-file hint when the project has no target set", () => {
    const p = baseProject({ targetLanguage: null })
    expect(resolveDefaultLaneLabel(p, "Spanish")).toBe("Spanish")
  })

  it("returns '' when neither source is set, so the chip shows the placeholder", () => {
    const p = baseProject()
    expect(resolveDefaultLaneLabel(p, undefined)).toBe("")
    expect(laneChipLabel("", resolveDefaultLaneLabel(p, undefined), "No target set")).toBe(
      "No target set",
    )
  })

  it("treats whitespace-only values as unset on both sources", () => {
    expect(resolveDefaultLaneLabel(baseProject({ targetLanguage: "   " }), "  ")).toBe("")
    expect(resolveDefaultLaneLabel(baseProject({ targetLanguage: "  " }), " Spanish ")).toBe("Spanish")
  })

  it("never relabels a named lane", () => {
    const p = baseProject({ targetLanguage: "French" })
    expect(laneChipLabel("es", resolveDefaultLaneLabel(p, undefined))).toBe("es")
  })

  it("prefers the lane row's name over the tag", () => {
    const p = baseProject({ targetLanguage: "French" })
    expect(laneChipLabel("es", resolveDefaultLaneLabel(p, undefined), "Default", "Yoruba Team")).toBe(
      "Yoruba Team",
    )
  })
})

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
