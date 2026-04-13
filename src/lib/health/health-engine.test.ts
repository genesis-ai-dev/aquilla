import { describe, it, expect } from "vitest"
import { computeHealthMap } from "./health-engine"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    original: "test", translated: "", context: "", group: "", type: "text",
    originalHtml: undefined, status: "empty", history: [],
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
    expect(result.healthMap.get("c3")).toBe(100)
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
    // c1=100, c2=0 (no examples), c3 = avg(100, 0) = 50
    expect(result.healthMap.get("c3")).toBe(50)
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
    // c1=100, c2=avg(100)=100, c3=avg(100)=100
    expect(result.healthMap.get("c2")).toBe(100)
    expect(result.healthMap.get("c3")).toBe(100)
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
    expect(result.healthMap.get("c2")).toBe(100) // references c1 from f1
  })
})
