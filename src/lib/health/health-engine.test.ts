import { describe, it, expect } from "vitest"
import { computeHealthMap } from "./health-engine"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"

function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    original: "test", translated: "", context: "", group: "", type: "text",
    originalHtml: undefined, status: "empty", validationStatus: "none", activeValidators: [],
    history: [], threads: [],
    ...overrides,
  }
}

describe("computeHealthMap", () => {
  it("returns empty map for no cells", () => {
    const result = computeHealthMap(new Map())
    expect(result.healthMap.size).toBe(0)
    expect(result.projectHealth).toBe(0)
  })

  it("human-validated cell has 100% health", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "bonjour", status: "validated", history: [
        { timestamp: "t1", value: "bonjour", source: "human", author: "user", validated: true },
      ] }),
    ]]])
    const result = computeHealthMap(cells)
    expect(result.healthMap.get("c1")).toBe(100)
  })

  it("empty cell is not in the health map", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1" }),
    ]]])
    const result = computeHealthMap(cells)
    expect(result.healthMap.has("c1")).toBe(false)
  })

  it("LLM cell with no examples has 0% health", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "bonjour", status: "unvalidated", history: [
        { timestamp: "t1", value: "bonjour", source: "llm", author: "model", validated: false },
      ] }),
    ]]])
    const result = computeHealthMap(cells)
    expect(result.healthMap.get("c1")).toBe(0)
  })

  it("LLM cell with all validated examples has 100% health", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "hello", status: "validated", history: [
        { timestamp: "t1", value: "hello", source: "human", author: "user", validated: true },
      ] }),
      makeCell({ id: "c2", translated: "world", status: "validated", history: [
        { timestamp: "t2", value: "world", source: "human", author: "user", validated: true },
      ] }),
      makeCell({ id: "c3", translated: "bonjour", status: "unvalidated", history: [
        { timestamp: "t3", value: "bonjour", source: "llm", author: "model", validated: false, examples: ["c1", "c2"] },
      ] }),
    ]]])
    const result = computeHealthMap(cells)
    // avg(100, 100) * 0.9 = 90
    expect(result.healthMap.get("c3")).toBe(90)
  })

  it("LLM cell with mixed examples has proportional health", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "hello", status: "validated", history: [
        { timestamp: "t1", value: "hello", source: "human", author: "user", validated: true },
      ] }),
      makeCell({ id: "c2", translated: "world", status: "unvalidated", history: [
        { timestamp: "t2", value: "world", source: "llm", author: "model", validated: false },
      ] }),
      makeCell({ id: "c3", translated: "bonjour", status: "unvalidated", history: [
        { timestamp: "t3", value: "bonjour", source: "llm", author: "model", validated: false, examples: ["c1", "c2"] },
      ] }),
    ]]])
    const result = computeHealthMap(cells)
    // c1=100, c2=0 (no examples), c3 = avg(100, 0) * 0.9 = 45
    expect(result.healthMap.get("c3")).toBe(45)
  })

  it("cascading health: LLM depends on LLM depends on validated", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "a", status: "validated", history: [
        { timestamp: "t1", value: "a", source: "human", author: "user", validated: true },
      ] }),
      makeCell({ id: "c2", translated: "b", status: "unvalidated", history: [
        { timestamp: "t2", value: "b", source: "llm", author: "model", validated: false, examples: ["c1"] },
      ] }),
      makeCell({ id: "c3", translated: "c", status: "unvalidated", history: [
        { timestamp: "t3", value: "c", source: "llm", author: "model", validated: false, examples: ["c2"] },
      ] }),
    ]]])
    const result = computeHealthMap(cells)
    // c1=100, c2=avg(100)*0.9=90, c3=avg(90)*0.9=81
    expect(result.healthMap.get("c2")).toBe(90)
    expect(result.healthMap.get("c3")).toBe(81)
  })

  it("computes file progress correctly", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1" }), // empty
      makeCell({ id: "c2", translated: "x", status: "validated", history: [
        { timestamp: "t1", value: "x", source: "human", author: "user", validated: true },
      ] }),
      makeCell({ id: "c3", translated: "y", status: "unvalidated", history: [
        { timestamp: "t2", value: "y", source: "llm", author: "model", validated: false },
      ] }),
    ]]])
    const result = computeHealthMap(cells)
    const progress = result.fileProgress.get("f1")!
    expect(progress.total).toBe(3)
    expect(progress.translated).toBe(2)
    expect(progress.validated).toBe(1)
  })

  it("computes file health as average of non-empty cells", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1" }), // empty, not counted
      makeCell({ id: "c2", translated: "x", status: "validated", history: [
        { timestamp: "t1", value: "x", source: "human", author: "user", validated: true },
      ] }), // 100
      makeCell({ id: "c3", translated: "y", status: "unvalidated", history: [
        { timestamp: "t2", value: "y", source: "llm", author: "model", validated: false },
      ] }), // 0
    ]]])
    const result = computeHealthMap(cells)
    expect(result.fileHealth.get("f1")).toBe(50) // avg(100, 0)
  })

  it("computes project health across files", () => {
    const cells = new Map([
      ["f1", [
        makeCell({ id: "c1", translated: "a", status: "validated", history: [
          { timestamp: "t1", value: "a", source: "human", author: "user", validated: true },
        ] }), // 100
      ]],
      ["f2", [
        makeCell({ id: "c2", translated: "b", status: "unvalidated", history: [
          { timestamp: "t2", value: "b", source: "llm", author: "model", validated: false },
        ] }), // 0
      ]],
    ])
    const result = computeHealthMap(cells)
    expect(result.projectHealth).toBe(50) // avg(100, 0)
  })

  it("handles cross-file example references", () => {
    const cells = new Map([
      ["f1", [
        makeCell({ id: "c1", translated: "a", status: "validated", history: [
          { timestamp: "t1", value: "a", source: "human", author: "user", validated: true },
        ] }),
      ]],
      ["f2", [
        makeCell({ id: "c2", translated: "b", status: "unvalidated", history: [
          { timestamp: "t2", value: "b", source: "llm", author: "model", validated: false, examples: ["c1"] },
        ] }),
      ]],
    ])
    const result = computeHealthMap(cells)
    expect(result.healthMap.get("c2")).toBe(90) // avg(100) * 0.9 = 90
  })

  it("applies rule infraction penalties to health", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", original: "Chapter 5", translated: "Chapitre", status: "validated", history: [
        { timestamp: "t1", value: "Chapitre", source: "human", author: "user", validated: true },
      ] }),
    ]]])
    const rules: TranslationRule[] = [{
      id: "r1", name: "Preserve numbers", description: "", severity: "major",
      source: "user", scope: "project", enabled: true, createdAt: "t1",
      check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" },
    }]
    const result = computeHealthMap(cells, 0.9, rules, { major: 15, minor: 5 })
    // base health = 100 (validated), minus 15 for major infraction = 85
    expect(result.healthMap.get("c1")).toBe(85)
    expect(result.infractions.get("c1")).toHaveLength(1)
  })

  it("respects custom LLM health multiplier", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "a", status: "validated", history: [
        { timestamp: "t1", value: "a", source: "human", author: "user", validated: true },
      ] }),
      makeCell({ id: "c2", translated: "b", status: "unvalidated", history: [
        { timestamp: "t2", value: "b", source: "llm", author: "model", validated: false, examples: ["c1"] },
      ] }),
    ]]])
    // 50% penalty
    const result = computeHealthMap(cells, 0.5)
    expect(result.healthMap.get("c2")).toBe(50) // avg(100) * 0.5
  })
})
