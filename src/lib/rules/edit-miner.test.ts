import { describe, it, expect } from "vitest"
import {
  mineRepeatedEdits,
  mineRecentEdits,
  mineHumanAuthoredEdits,
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

// ---------------------------------------------------------------------------
// mineHumanAuthoredEdits — AQU-820
// ---------------------------------------------------------------------------

/** A hand-translated, never-AI-drafted, never-explicitly-validated cell. */
function humanCell(original: string, translated: string): MinerCell {
  return { original, translated, status: "unvalidated", hasPendingEdit: false }
}

describe("mineHumanAuthoredEdits (AQU-820)", () => {
  it("mines human-authored targets that no other tier would catch", () => {
    // Unique pairs (no repeats), nothing pending, nothing validated — every
    // pre-AQU-820 tier returns zero on this shape.
    const cells = [humanCell("In the beginning", "起初"), humanCell("God said", "神說")]
    expect(mineRepeatedEdits(cells)).toHaveLength(0)
    expect(mineRecentEdits(cells)).toHaveLength(0)

    const result = mineHumanAuthoredEdits(cells)
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe("human-authored")
    expect(result[0].sourceSample).toBe("In the beginning")
    expect(result[0].targetSample).toBe("起初")
  })

  it("skips untouched AI drafts but keeps post-edited and legacy rows", () => {
    const result = mineHumanAuthoredEdits([
      { original: "a", translated: "A", status: "unvalidated", aiDrafted: true },
      { original: "b", translated: "B", status: "unvalidated", aiDrafted: false },
      { original: "c", translated: "C", status: "unvalidated" }, // legacy: flag absent
    ])
    expect(result.map((c) => c.sourceSample)).toEqual(["b", "c"])
  })

  it("skips empty and untranslated cells", () => {
    const result = mineHumanAuthoredEdits([
      { original: "a", translated: "", status: "empty" },
      { original: "", translated: "B", status: "unvalidated" },
      { original: "  ", translated: "  ", status: "unvalidated" },
      humanCell("d", "D"),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].sourceSample).toBe("d")
  })

  it("caps output so a full New Testament doesn't flood the prompt", () => {
    const many = Array.from({ length: 500 }, (_, i) => humanCell(`src ${i}`, `tgt ${i}`))
    expect(mineHumanAuthoredEdits(many)).toHaveLength(40)
    expect(mineHumanAuthoredEdits(many, 5)).toHaveLength(5)
  })

  it("marks validated human cells distinctly in their evidence string", () => {
    const result = mineHumanAuthoredEdits([
      humanCell("a", "A"),
      { original: "b", translated: "B", status: "validated" },
    ])
    expect(result[0].evidence).toBe("Human-authored translation")
    expect(result[1].evidence).toBe("Human-authored translation (validated)")
  })
})

describe("mineCandidates — human-authored corpora (AQU-820)", () => {
  it("produces candidates for a hand-translated project with no validated pairs", () => {
    // The AQU-820 repro: a Codex-imported project translated entirely by hand.
    // No AI pre-drafts, no repeats, no pending edits, no validation → this
    // returned zero candidates before the human-authored tier existed.
    const cells = Array.from({ length: 30 }, (_, i) =>
      humanCell(`Verse ${i} source text`, `Verse ${i} 譯文`),
    )
    const result = mineCandidates(cells, [])
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((c) => c.kind === "human-authored")).toBe(true)
  })

  it("no regression: post-edited AI drafts still rank above the human-authored tier", () => {
    const cells: MinerCell[] = [
      cell("God", "Dios"),
      cell("God", "Dios"),
      cell("Recent", "Reciente", "unvalidated", true),
      humanCell("Plain", "Llano"),
    ]
    const pairs = [{ source: "Lord", target: "Señor" }]
    const result = mineCandidates(cells, pairs)

    expect(result[0].kind).toBe("repeated")
    const kinds = result.map((c) => c.kind)
    expect(kinds).toContain("recent")
    expect(kinds).toContain("validated-pair")
    // The new tier is last, and never outranks an established one.
    const humanScores = result.filter((c) => c.kind === "human-authored").map((c) => c.score)
    const otherScores = result.filter((c) => c.kind !== "human-authored").map((c) => c.score)
    expect(Math.max(...humanScores)).toBeLessThan(Math.min(...otherScores))
  })

  it("does not double-count a cell already surfaced by a higher tier", () => {
    // The same cell is both a validated pair and human-authored; dedupe by key
    // must keep only the higher-ranked validated-pair entry.
    const cells: MinerCell[] = [{ original: "Lord", translated: "Señor", status: "validated" }]
    const result = mineCandidates(cells, [{ source: "Lord", target: "Señor" }])
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("validated-pair")
  })
})
