// AQU-1387: the AI-section overlay on derived navigation.
//
// Kept in its own file because every case here needs the kill switch forced on
// — the switch is off on `dev` until the eval clears, and the sibling
// `milestone-navigation.test.ts` asserts the unoverlaid behaviour that ships.

import { afterEach, describe, expect, it } from "vitest"
import type { BoundaryLevel, BoundarySource } from "@/lib/import/ai-sections"
import { setAiSectionMilestonesEnabled } from "@/lib/import/ai-sections-flag"
import {
  deriveMilestoneNavigation,
  type MilestoneNavigationCell,
} from "./milestone-navigation"
import type { ImportMilestone } from "../../shared/import-contract"

afterEach(() => {
  setAiSectionMilestonesEnabled(false)
})

function plain(id: string, original = id): MilestoneNavigationCell {
  return { id, original }
}

function persisted(id: string, milestone: ImportMilestone): MilestoneNavigationCell {
  return { id, original: id, metadata: { aquillaImport: { milestone } } }
}

/** Every seam scored at `level`, with per-seam overrides. */
function levels(
  count: number,
  level: BoundaryLevel,
  at: Record<number, BoundaryLevel> = {},
): BoundarySource {
  return (index) => (
    index < 0 || index >= count - 1 ? undefined : { level: at[index] ?? level }
  )
}

function labels(cells: readonly MilestoneNavigationCell[], boundaries?: BoundarySource) {
  return deriveMilestoneNavigation(cells, boundaries ? { boundaries } : {})
    .orderedMilestones
    .map(({ milestone }) => `${milestone.kind}:${milestone.label}`)
}

describe("AI section overlay", () => {
  const unstructured = Array.from({ length: 120 }, (_, index) => plain(
    `c${index}`,
    index === 0
      ? "The village of Ban Mai sits above the river"
      : index === 60
        ? "Three years later the road arrived"
        : `line ${index}`,
  ))

  it("replaces Part N with sections named after their opening words", () => {
    setAiSectionMilestonesEnabled(true)
    expect(labels(unstructured, levels(120, 1, { 59: 4 }))).toEqual([
      "ai-section:The village of Ban Mai sits above the river",
      "ai-section:Three years later the road arrived",
    ])
  })

  it("leaves Part N alone when the switch is off", () => {
    // The default on `dev`. Scored seams present and deliberately ignored.
    expect(labels(unstructured, levels(120, 1, { 59: 4 }))).toEqual(["part:Part 1", "part:Part 2", "part:Part 3"])
  })

  it("leaves Part N alone when the scorer has no answers", () => {
    setAiSectionMilestonesEnabled(true)
    expect(labels(unstructured, () => undefined)).toEqual(["part:Part 1", "part:Part 2", "part:Part 3"])
    // And when no boundaries are supplied at all — the call every existing
    // caller makes today.
    expect(labels(unstructured)).toEqual(["part:Part 1", "part:Part 2", "part:Part 3"])
  })

  it("never touches a division that came out of the file", () => {
    setAiSectionMilestonesEnabled(true)
    const scripture = Array.from({ length: 60 }, (_, index) => persisted(`v${index}`, {
      key: `scripture:LUK:${index < 30 ? 5 : 6}`,
      kind: "chapter",
      label: `Luke ${index < 30 ? 5 : 6}`,
      shortLabel: String(index < 30 ? 5 : 6),
    }))
    // Level 4 on every seam: if the overlay could reach explicit milestones it
    // would shred this file into sixty divisions.
    expect(labels(scripture, levels(60, 4))).toEqual(["chapter:Luke 5", "chapter:Luke 6"])
  })

  // An IDML/PPTX import persists a MIX: units with a story or slide get that
  // milestone, units without one get `part` (see `idmlStoryMilestones`). That
  // is the real shape a partly-structured file has on re-read.
  function partStructured(tailText: (index: number) => string): MilestoneNavigationCell[] {
    return [
      ...Array.from({ length: 10 }, (_, index) => persisted(`s${index}`, {
        key: "story:cover.xml:s1",
        kind: "story",
        label: "Cover",
        shortLabel: "1",
      })),
      ...Array.from({ length: 40 }, (_, index) => persisted(`t${index}`, {
        key: "part:t0",
        kind: "part",
        label: "Part 1",
        shortLabel: "1",
      })),
    ].map((cell, index) => (index < 10
      ? cell
      : { ...cell, original: tailText(index - 10) }))
  }

  it("re-cuts only the app-invented stretch of a part-structured file", () => {
    setAiSectionMilestonesEnabled(true)
    const mixed = partStructured((index) => (
      index === 0 ? "The untitled remainder begins" : `tail ${index}`
    ))
    expect(labels(mixed, levels(50, 1))).toEqual([
      "story:Cover",
      "ai-section:The untitled remainder begins",
    ])
  })

  it("scores the app-invented stretch with the seams that belong to it", () => {
    setAiSectionMilestonesEnabled(true)
    const mixed = partStructured((index) => (
      index === 20 ? "A second thought entirely" : `tail ${index}`
    ))
    // Seam 29 is between t19 and t20 in FILE coordinates, which is seam 19
    // within the run. An overlay that forgot to offset seam indices to the
    // run's start would break somewhere else entirely.
    expect(labels(mixed, levels(50, 1, { 29: 4 }))).toEqual([
      "story:Cover",
      "ai-section:tail 0",
      "ai-section:A second thought entirely",
    ])
  })

  it("replaces the 5-minute buckets of a transcript, keeping the clock in the label", () => {
    setAiSectionMilestonesEnabled(true)
    const transcript = Array.from({ length: 40 }, (_, index) => ({
      id: `cue${index}`,
      original: index === 0
        ? "Welcome back to the programme"
        : index === 20
          ? "After the break we turn to the harvest"
          : `cue text ${index}`,
      startMs: index * 30_000,
    }))
    expect(labels(transcript, () => undefined))
      .toEqual(["time-range:00:00–05:00", "time-range:05:00–10:00", "time-range:10:00–15:00", "time-range:15:00–20:00"])
    expect(labels(transcript, levels(40, 1, { 19: 4 }))).toEqual([
      "ai-section:00:00–09:30 · Welcome back to the programme",
      "ai-section:10:00–19:30 · After the break we turn to the harvest",
    ])
  })

  it("assigns every cell to exactly one section", () => {
    setAiSectionMilestonesEnabled(true)
    const navigation = deriveMilestoneNavigation(unstructured, {
      boundaries: levels(120, 1, { 59: 4 }),
    })
    expect(navigation.milestoneByCellId.size).toBe(120)
    const covered = navigation.orderedMilestones.flatMap(({ cellIds }) => cellIds)
    expect(covered).toHaveLength(120)
    expect(new Set(covered).size).toBe(120)
  })

  it("honours an explicit opt-out even with the switch on", () => {
    setAiSectionMilestonesEnabled(true)
    const navigation = deriveMilestoneNavigation(unstructured, {
      boundaries: levels(120, 1, { 59: 4 }),
      aiSections: false,
    })
    expect(navigation.orderedMilestones[0].milestone.kind).toBe("part")
  })

  it("keeps a persisted AI section on re-read", () => {
    // Shape-compatibility with AQU-318: once milestones become events, an
    // ai-section must survive the round trip like any other kind.
    const cells = [persisted("a", {
      key: "ai-section:a",
      kind: "ai-section",
      label: "The village of Ban Mai",
      shortLabel: "1",
    })]
    expect(labels(cells)).toEqual(["ai-section:The village of Ban Mai"])
  })
})
