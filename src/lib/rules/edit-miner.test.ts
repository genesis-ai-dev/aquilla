import { describe, it, expect } from "vitest"
import {
  mineRepeatedEdits,
  mineRecentEdits,
  combineAndRankCandidates,
  validatedPairsToCandidate,
  mineCandidates,
  type MinerCell,
} from "./edit-miner"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cell(
  original: string,
  translated: string,
  status: MinerCell["status"] = "validated",
  hasPendingEdit = false,
): MinerCell {
  return { original, translated, status, hasPendingEdit }
}

// ---------------------------------------------------------------------------
// mineRepeatedEdits
// ---------------------------------------------------------------------------

describe("mineRepeatedEdits", () => {
  it("returns empty when all translations are unique", () => {
    const cells: MinerCell[] = [
      cell("Hello", "Bonjour"),
      cell("World", "Monde"),
    ]
    expect(mineRepeatedEdits(cells)).toHaveLength(0)
  })

  it("detects when the same (source, target) appears in 2+ cells", () => {
    const cells: MinerCell[] = [
      cell("God", "Dios"),
      cell("God", "Dios"),
      cell("Lord", "Señor"),
    ]
    const result = mineRepeatedEdits(cells)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("repeated")
    expect(result[0].evidence).toMatch(/2 cells/)
  })

  it("higher repetition counts score higher", () => {
    const cells: MinerCell[] = [
      cell("God", "Dios"),
      cell("God", "Dios"),
      cell("God", "Dios"),
      cell("Lord", "Señor"),
      cell("Lord", "Señor"),
    ]
    const result = mineRepeatedEdits(cells)
    expect(result[0].sourceSample).toBe("God") // 3 occurrences beats 2
    expect(result[0].score).toBeGreaterThan(result[1].score)
  })

  it("ignores empty cells", () => {
    const cells: MinerCell[] = [
      cell("", "Dios"),
      cell("God", ""),
      cell("", "", "empty"),
    ]
    expect(mineRepeatedEdits(cells)).toHaveLength(0)
  })

  it("normalises case when comparing", () => {
    const cells: MinerCell[] = [
      cell("god", "dios"),
      cell("God", "Dios"),
    ]
    const result = mineRepeatedEdits(cells)
    expect(result).toHaveLength(1)
    expect(result[0].evidence).toMatch(/2 cells/)
  })
})

// ---------------------------------------------------------------------------
// mineRecentEdits
// ---------------------------------------------------------------------------

describe("mineRecentEdits", () => {
  it("returns only cells with hasPendingEdit=true", () => {
    const cells: MinerCell[] = [
      cell("A", "a", "validated", true),
      cell("B", "b", "unvalidated", false),
      cell("C", "c", "validated", true),
    ]
    const result = mineRecentEdits(cells)
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.kind === "recent")).toBe(true)
  })

  it("returns empty when no pending edits", () => {
    const cells: MinerCell[] = [cell("A", "a"), cell("B", "b")]
    expect(mineRecentEdits(cells)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// combineAndRankCandidates
// ---------------------------------------------------------------------------

describe("combineAndRankCandidates", () => {
  it("orders: repeated > recent > validated-pair", () => {
    const repeated = mineRepeatedEdits([
      cell("God", "Dios"),
      cell("God", "Dios"),
    ])
    const recent = mineRecentEdits([cell("Spirit", "Espíritu", "validated", true)])
    const pairs = validatedPairsToCandidate([{ source: "Lord", target: "Señor" }])

    const result = combineAndRankCandidates(repeated, recent, pairs)
    expect(result[0].kind).toBe("repeated")
    expect(result[1].kind).toBe("recent")
    expect(result[2].kind).toBe("validated-pair")
  })

  it("deduplicates across tiers by key", () => {
    // Same (source, target) appears as repeated AND as a validated pair
    const repeated = mineRepeatedEdits([
      cell("God", "Dios"),
      cell("God", "Dios"),
    ])
    const pairs = validatedPairsToCandidate([{ source: "God", target: "Dios" }])
    const result = combineAndRankCandidates(repeated, [], pairs)
    // Should appear only once (as repeated, the higher-priority tier)
    expect(result.filter((r) => r.sourceSample.toLowerCase() === "god")).toHaveLength(1)
    expect(result.find((r) => r.sourceSample.toLowerCase() === "god")?.kind).toBe("repeated")
  })
})

// ---------------------------------------------------------------------------
// mineCandidates (integration)
// ---------------------------------------------------------------------------

describe("mineCandidates", () => {
  it("returns empty list when no cells and no pairs", () => {
    expect(mineCandidates([], [])).toHaveLength(0)
  })

  it("combines all sources and sorts by score", () => {
    const cells: MinerCell[] = [
      cell("God", "Dios"),
      cell("God", "Dios"),
      cell("Recent", "Reciente", "unvalidated", true),
    ]
    const pairs = [{ source: "Lord", target: "Señor" }]
    const result = mineCandidates(cells, pairs)
    expect(result.length).toBeGreaterThan(0)
    // First result must be repeated (highest score)
    expect(result[0].kind).toBe("repeated")
  })
})
