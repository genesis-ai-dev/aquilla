import { describe, it, expect } from "vitest"
import type { Concept } from "./types"
import { computeTerminologyStats } from "./stats"
import type { CellPair } from "./stats"

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "c1",
    sourceTerm: "spirit",
    renderings: [
      { rendering: "espíritu", status: "preferred" },
      { rendering: "aliento", status: "admitted" },
      { rendering: "ghost", status: "forbidden" },
    ],
    status: "active",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  }
}

function cell(original: string, translated: string): CellPair {
  return { original, translated }
}

// ────────────────────────────────────────────────────────────────────────────
// Clean project → 0% infringed
// ────────────────────────────────────────────────────────────────────────────

describe("computeTerminologyStats — clean project", () => {
  it("yields 0% infringed when every occurrence uses an approved rendering", () => {
    const concepts = [makeConcept()]
    const cells: CellPair[] = [
      cell("The spirit moves.", "El espíritu se mueve."),
      cell("A spirit appeared.", "Un aliento apareció."),
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.infringedPct).toBe(0)
    expect(stats.enforcedPct).toBe(100)
    expect(stats.byConcept[0].infringed).toBe(0)
    expect(stats.byConcept[0].enforced).toBe(2)
  })

  it("yields 0% infringed when source term is absent from all cells", () => {
    const concepts = [makeConcept()]
    const cells: CellPair[] = [
      cell("God is love.", "Dios es amor."),
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.infringedPct).toBe(0)
    expect(stats.enforcedPct).toBe(0)
    expect(stats.byConcept[0].occurrences).toBe(0)
  })

  it("yields 0% infringed with empty cells array", () => {
    const stats = computeTerminologyStats([makeConcept()], [])
    expect(stats.infringedPct).toBe(0)
    expect(stats.enforcedPct).toBe(0)
    expect(stats.totalCells).toBe(0)
  })

  it("yields 0% infringed with empty concepts array", () => {
    const stats = computeTerminologyStats([], [cell("The spirit moves.", "El espíritu.")])
    expect(stats.totalConcepts).toBe(0)
    expect(stats.infringedPct).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Infringement detection
// ────────────────────────────────────────────────────────────────────────────

describe("computeTerminologyStats — infringement detection", () => {
  it("counts a cell as infringed when approved rendering is absent", () => {
    const concepts = [makeConcept({
      renderings: [{ rendering: "espíritu", status: "preferred" }],
    })]
    const cells: CellPair[] = [
      cell("The spirit came.", "El alma vino."), // wrong rendering
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.byConcept[0].infringed).toBe(1)
    expect(stats.infringedPct).toBe(100)
  })

  it("counts a cell as infringed when a forbidden rendering is present", () => {
    const concepts = [makeConcept({
      renderings: [
        { rendering: "espíritu", status: "preferred" },
        { rendering: "ghost", status: "forbidden" },
      ],
    })]
    const cells: CellPair[] = [
      cell("The spirit came.", "Holy ghost appeared."), // forbidden present
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.byConcept[0].infringed).toBe(1)
    expect(stats.infringedPct).toBe(100)
  })

  it("does not count a cell as infringed when source term is absent", () => {
    const concepts = [makeConcept()]
    const cells: CellPair[] = [
      cell("God is love.", "Holy ghost."), // forbidden in target but source term absent
    ]
    const stats = computeTerminologyStats(concepts, cells)
    // source doesn't contain "spirit" → na → not counted
    expect(stats.byConcept[0].occurrences).toBe(0)
    expect(stats.byConcept[0].infringed).toBe(0)
    expect(stats.infringedPct).toBe(0)
  })

  it("mixes enforced and infringed cells correctly", () => {
    const concepts = [makeConcept({
      renderings: [{ rendering: "espíritu", status: "preferred" }],
    })]
    const cells: CellPair[] = [
      cell("The spirit moves.", "El espíritu se mueve."), // enforced
      cell("A spirit came.", "Un alma vino."),           // infringed
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.byConcept[0].enforced).toBe(1)
    expect(stats.byConcept[0].infringed).toBe(1)
    expect(stats.infringedPct).toBe(50)
    expect(stats.enforcedPct).toBe(50)
  })

  it("skips draft and deprecated concepts", () => {
    const concepts = [
      makeConcept({ id: "c1", status: "draft" }),
      makeConcept({ id: "c2", status: "deprecated" }),
    ]
    const cells: CellPair[] = [cell("The spirit.", "El alma.")]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.totalConcepts).toBe(0)
    expect(stats.byConcept).toHaveLength(0)
    expect(stats.infringedPct).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// top-5 ordering
// ────────────────────────────────────────────────────────────────────────────

describe("computeTerminologyStats — top5Infringed ordering", () => {
  it("orders top5 by infringed count descending", () => {
    // 6 concepts, infringed counts: 3, 1, 5, 2, 0, 4
    const concepts: Concept[] = [
      makeConcept({ id: "c1", sourceTerm: "spirit" }),
      makeConcept({ id: "c2", sourceTerm: "grace" }),
      makeConcept({ id: "c3", sourceTerm: "faith" }),
      makeConcept({ id: "c4", sourceTerm: "love" }),
      makeConcept({ id: "c5", sourceTerm: "hope" }),
      makeConcept({ id: "c6", sourceTerm: "truth" }),
    ].map((c) => ({ ...c, renderings: [{ rendering: "APPROVED_" + c.id, status: "preferred" as const }] }))

    // Build cells: for each concept produce N cells where source has the term
    // but target is always wrong (no approved rendering → infringed).
    const counts: Record<string, number> = {
      spirit: 3,
      grace: 1,
      faith: 5,
      love: 2,
      hope: 0,
      truth: 4,
    }
    const cells: CellPair[] = Object.entries(counts).flatMap(([term, n]) =>
      Array.from({ length: n }, () => cell(`The ${term} of God.`, "wrong rendering.")),
    )

    const stats = computeTerminologyStats(concepts, cells)
    const top5Terms = stats.top5Infringed.map((s) => s.sourceTerm)
    // Expected order: faith(5), truth(4), spirit(3), love(2), grace(1). hope(0) excluded.
    expect(top5Terms).toEqual(["faith", "truth", "spirit", "love", "grace"])
    expect(stats.top5Infringed).toHaveLength(5)
  })

  it("excludes concepts with 0 infringed from top5", () => {
    const concepts = [makeConcept()]
    const cells: CellPair[] = [
      cell("The spirit.", "El espíritu."), // enforced
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.top5Infringed).toHaveLength(0)
  })

  it("returns fewer than 5 when fewer concepts are infringed", () => {
    const concepts = [
      makeConcept({ id: "c1", sourceTerm: "spirit", renderings: [{ rendering: "wrong_expected", status: "preferred" }] }),
      makeConcept({ id: "c2", sourceTerm: "grace", renderings: [{ rendering: "gracia", status: "preferred" }] }),
    ]
    const cells: CellPair[] = [
      cell("The spirit moves.", "El alma."),  // infringed c1
      cell("God's grace.", "La gracia de Dios."), // enforced c2
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.top5Infringed).toHaveLength(1)
    expect(stats.top5Infringed[0].sourceTerm).toBe("spirit")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Aggregate totals
// ────────────────────────────────────────────────────────────────────────────

describe("computeTerminologyStats — aggregate totals", () => {
  it("reports correct totalConcepts and totalCells", () => {
    const concepts = [makeConcept({ id: "c1" }), makeConcept({ id: "c2", sourceTerm: "grace" })]
    const cells = [cell("a", "b"), cell("c", "d"), cell("e", "f")]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.totalConcepts).toBe(2)
    expect(stats.totalCells).toBe(3)
  })

  it("infringedRate is per-concept occurrences", () => {
    const concepts = [makeConcept({
      renderings: [{ rendering: "espíritu", status: "preferred" }],
    })]
    const cells: CellPair[] = [
      cell("The spirit.", "El espíritu."), // enforced
      cell("The spirit.", "El alma."),     // infringed
      cell("The spirit.", "El alma."),     // infringed
    ]
    const stats = computeTerminologyStats(concepts, cells)
    expect(stats.byConcept[0].infringedRate).toBeCloseTo(2 / 3)
  })
})
