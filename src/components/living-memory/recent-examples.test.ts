import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { selectRecentValidatedExamples } from "./recent-examples"

function makeCell(overrides: Partial<CellData> & { id: string; history?: CellHistoryEntry[] }): CellData {
  return {
    id: "default",
    original: "source",
    translated: "target",
    context: "",
    group: "",
    type: "text",
    originalHtml: undefined,
    status: "validated",
    validationStatus: "full",
    activeValidators: ["ryder"],
    history: [],
    threads: [],
    ...overrides,
  }
}

function makeEntry(timestamp: string, author = "ryder"): CellHistoryEntry {
  return { timestamp, value: "target", source: "human", author, validated: true }
}

describe("selectRecentValidatedExamples", () => {
  it("returns empty array when no cells are provided", () => {
    expect(selectRecentValidatedExamples([], 10)).toEqual([])
  })

  it("includes cells with validationStatus=full", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "full", history: [makeEntry("2026-04-17T10:00:00Z")] }),
    ]
    const result = selectRecentValidatedExamples(cells, 10)
    expect(result).toHaveLength(1)
    expect(result[0].cellId).toBe("c1")
  })

  it("includes cells with validationStatus=self", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "self", history: [makeEntry("2026-04-17T10:00:00Z")] }),
    ]
    expect(selectRecentValidatedExamples(cells, 10)).toHaveLength(1)
  })

  it("excludes unvalidated cells", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "none" }),
      makeCell({ id: "c2", validationStatus: "empty" }),
    ]
    expect(selectRecentValidatedExamples(cells, 10)).toEqual([])
  })

  it("sorts by most recent history timestamp, descending", () => {
    const cells = [
      makeCell({ id: "older", validationStatus: "full", history: [makeEntry("2026-04-01T00:00:00Z")] }),
      makeCell({ id: "newer", validationStatus: "full", history: [makeEntry("2026-04-15T00:00:00Z")] }),
    ]
    const result = selectRecentValidatedExamples(cells, 10)
    expect(result.map((r) => r.cellId)).toEqual(["newer", "older"])
  })

  it("limits the result to N", () => {
    const cells = Array.from({ length: 20 }, (_, i) =>
      makeCell({
        id: `c${i}`,
        validationStatus: "full",
        history: [makeEntry(`2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`)],
      }),
    )
    const result = selectRecentValidatedExamples(cells, 5)
    expect(result).toHaveLength(5)
    // Most recent first — c19 (day 20) should be first.
    expect(result[0].cellId).toBe("c19")
  })

  it("handles cells with no history (uses fallback sort key)", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "full", history: [] }),
    ]
    const result = selectRecentValidatedExamples(cells, 10)
    expect(result).toHaveLength(1)
  })
})
