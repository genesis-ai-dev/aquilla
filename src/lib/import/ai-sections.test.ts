import { describe, expect, it } from "vitest"
import {
  AI_SECTION_MAX_UNITS,
  MIN_SCORED_COVERAGE,
  aiSectionMilestones,
  planAiSections,
  scoreSeams,
  type BoundaryLevel,
  type BoundarySource,
  type ScoredBoundary,
  type SectionPlanCell,
} from "./ai-sections"

function cells(count: number, text: (index: number) => string = (i) => `cell ${i}`): SectionPlanCell[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `c${index}`,
    text: text(index),
  }))
}

/** Every seam scored at `level` unless listed in `at`. */
function levels(
  count: number,
  level: BoundaryLevel,
  at: Record<number, BoundaryLevel | ScoredBoundary> = {},
): BoundarySource {
  return (index) => {
    if (index < 0 || index >= count - 1) return undefined
    const override = at[index]
    if (override === undefined) return { level }
    return typeof override === "number" ? { level: override } : override
  }
}

describe("AI section milestones", () => {
  it("keeps the caller's fallback when no seam has been scored", () => {
    expect(planAiSections(cells(120), () => undefined)).toBeNull()
    expect(aiSectionMilestones(cells(120), () => undefined)).toBeNull()
  })

  it("keeps the caller's fallback while a file is only partly scored", () => {
    // Classification runs in windows; dividing on a partial read would make the
    // navigator's sections move under the translator as later windows land.
    const scoredSeams = Math.floor((100 - 1) * MIN_SCORED_COVERAGE) - 1
    const partial: BoundarySource = (index) => (
      index < scoredSeams ? { level: index === 40 ? 4 : 1 } : undefined
    )
    expect(planAiSections(cells(100), partial)).toBeNull()

    const covered: BoundarySource = (index) => (
      index < 99 ? { level: index === 40 ? 4 : 1 } : undefined
    )
    expect(planAiSections(cells(100), covered)).not.toBeNull()
  })

  it("divides at level-4 seams and labels each section with its opening words", () => {
    const sections = planAiSections(
      cells(30, (index) => (index === 0
        ? "In the beginning God created"
        : index === 12
          ? "Now Jethro the priest of Midian heard"
          : `line ${index}`)),
      levels(30, 1, { 11: 4 }),
      { minUnits: 4 },
    )

    expect(sections?.map((section) => [section.startIndex, section.endIndex])).toEqual([
      [0, 11],
      [12, 29],
    ])
    expect(sections?.map((section) => section.milestone)).toEqual([
      {
        key: "ai-section:c0",
        kind: "ai-section",
        label: "In the beginning God created",
        shortLabel: "1",
      },
      {
        key: "ai-section:c12",
        kind: "ai-section",
        label: "Now Jethro the priest of Midian heard",
        shortLabel: "2",
      },
    ])
  })

  it("ignores a level-4 seam the model is not confident about", () => {
    const confident = planAiSections(cells(40), levels(40, 1, {
      19: { level: 4, confidence: 0.9 },
    }), { minUnits: 4 })
    expect(confident).toHaveLength(2)

    const unsure = planAiSections(cells(40), levels(40, 1, {
      19: { level: 4, confidence: 0.1 },
    }), { minUnits: 4 })
    // An unsure classifier that still votes is worse than the fixed size it
    // replaced, so the whole file stays one section.
    expect(unsure).toHaveLength(1)
  })

  it("does not divide at a level-3 seam — that is the passage layer's threshold", () => {
    const sections = planAiSections(cells(40), levels(40, 1, { 19: 3 }), { minUnits: 4 })
    expect(sections).toHaveLength(1)
  })

  it("merges a run shorter than the minimum into its neighbour", () => {
    // Three strong boundaries, but the middle run is only two cells long.
    const sections = planAiSections(
      cells(40),
      levels(40, 1, { 9: 4, 11: 4, 25: 4 }),
      { minUnits: 5 },
    )
    expect(sections?.map((section) => [section.startIndex, section.endIndex])).toEqual([
      [0, 11],
      [12, 25],
      [26, 39],
    ])
  })

  it("merges a short opening run forward, since nothing precedes it", () => {
    const sections = planAiSections(cells(40), levels(40, 1, { 1: 4, 20: 4 }), { minUnits: 5 })
    expect(sections?.map((section) => [section.startIndex, section.endIndex])).toEqual([
      [0, 20],
      [21, 39],
    ])
  })

  it("splits an oversized section at its strongest internal seam", () => {
    // No level-4 boundary anywhere, so the file starts as one 100-cell run.
    // The strongest thing inside it is the level-3 seam at 61.
    const sections = planAiSections(
      cells(100),
      levels(100, 1, { 20: 2, 61: 3 }),
      { minUnits: 5, maxUnits: 70 },
    )
    expect(sections?.map((section) => [section.startIndex, section.endIndex])).toEqual([
      [0, 61],
      [62, 99],
    ])
  })

  it("keeps splitting until every section fits, never leaving one over the ceiling", () => {
    const sections = planAiSections(cells(300), levels(300, 1), { minUnits: 5, maxUnits: 60 })
    expect(sections).not.toBeNull()
    for (const section of sections!) {
      expect(section.endIndex - section.startIndex + 1).toBeLessThanOrEqual(60)
    }
    // Sections come out in file order and cover every cell exactly once.
    expect(sections![0].startIndex).toBe(0)
    expect(sections!.at(-1)!.endIndex).toBe(299)
    for (let index = 1; index < sections!.length; index += 1) {
      expect(sections![index].startIndex).toBe(sections![index - 1].endIndex + 1)
    }
  })

  it("breaks a tie between equally strong seams by balancing the halves", () => {
    const sections = planAiSections(
      cells(100),
      levels(100, 1, { 10: 3, 49: 3, 90: 3 }),
      { minUnits: 5, maxUnits: 70 },
    )
    expect(sections?.[0].endIndex).toBe(49)
  })

  it("prefers the seam the model is more confident about", () => {
    const sections = planAiSections(
      cells(100),
      levels(100, 1, {
        30: { level: 3, confidence: 0.9 },
        49: { level: 3, confidence: 0.5 },
      }),
      { minUnits: 5, maxUnits: 70 },
    )
    expect(sections?.[0].endIndex).toBe(30)
  })

  it("never cuts a section shorter than the minimum when splitting an oversized one", () => {
    // The only scored seam sits two cells from the end; honouring it would
    // leave a two-cell tail, so the split falls back to a balanced cut.
    const sections = planAiSections(cells(80), levels(80, 1, { 77: 4 }), {
      minUnits: 10,
      maxUnits: 60,
    })
    expect(sections).not.toBeNull()
    for (const section of sections!) {
      expect(section.endIndex - section.startIndex + 1).toBeGreaterThanOrEqual(10)
    }
  })

  it("labels a section from the first cell that actually has text", () => {
    const sections = planAiSections(
      cells(20, (index) => (index === 0 ? "   " : index === 1 ? "The real opening" : "x")),
      levels(20, 1),
      { minUnits: 4 },
    )
    expect(sections?.[0].milestone.label).toBe("The real opening")
  })

  it("falls back to the caller's vocabulary when a whole section is empty", () => {
    const sections = planAiSections(cells(20, () => ""), levels(20, 1), {
      minUnits: 4,
      fallbackLabel: () => "Section",
    })
    expect(sections?.[0].milestone.label).toBe("Section")
    expect(sections?.[0].milestone.shortLabel).toBe("1")
  })

  it("clips a long opening on a word boundary", () => {
    const long = "Now it came to pass in those days that the whole company went out from the city"
    const sections = planAiSections(
      cells(20, (index) => (index === 0 ? long : "x")),
      levels(20, 1),
      { minUnits: 4 },
    )
    const label = sections![0].milestone.label
    expect(label.endsWith("…")).toBe(true)
    expect(label.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(label.slice(0, -1))).toBe(true)
  })

  it("prefixes media sections with their clock range", () => {
    const transcript: SectionPlanCell[] = Array.from({ length: 12 }, (_, index) => ({
      key: `cue${index}`,
      text: index === 0 ? "Welcome to the interview" : `line ${index}`,
      startMs: index * 30_000,
      endMs: index * 30_000 + 25_000,
    }))
    const sections = planAiSections(transcript, levels(12, 1), { minUnits: 4, clockPrefix: true })
    expect(sections?.[0].milestone.label).toBe("00:00–05:55 · Welcome to the interview")
  })

  it("assigns every cell a milestone, one per section", () => {
    const assignments = aiSectionMilestones(cells(30), levels(30, 1, { 14: 4 }), { minUnits: 4 })
    expect(assignments).toHaveLength(30)
    expect(new Set(assignments!.map((value) => value.key)).size).toBe(2)
    expect(assignments!.every(Boolean)).toBe(true)
  })

  it("rejects a level outside 0–4 rather than trusting the caller", () => {
    const bogus: BoundarySource = (index) => ({ level: (index === 1 ? 9 : 1) as BoundaryLevel })
    // Four seams, one of them nonsense: 3/4 coverage is below the bar, so the
    // file keeps its fallback rather than dividing on a level that means nothing.
    expect(scoreSeams(5, bogus)).toBeNull()

    // In a well-covered file the nonsense seam reads as unscored — and only it.
    const seams = scoreSeams(40, bogus)
    expect(seams?.[1]).toBeUndefined()
    expect(seams?.[2]).toEqual({ level: 1 })
  })

  it("has a default ceiling that stays near the fixed size it replaces", () => {
    // Guards against a future tweak that swings navigation density by an order
    // of magnitude the first time the scorer runs.
    expect(AI_SECTION_MAX_UNITS).toBeGreaterThan(20)
    expect(AI_SECTION_MAX_UNITS).toBeLessThan(120)
  })

  it("returns null for a single-cell file — there is nothing to divide", () => {
    expect(planAiSections(cells(1), levels(1, 4))).toBeNull()
  })
})
