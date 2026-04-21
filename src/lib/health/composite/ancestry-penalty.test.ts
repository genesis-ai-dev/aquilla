import { describe, it, expect } from "vitest"
import { ancestryPenalty } from "./ancestry-penalty"

describe("ancestryPenalty", () => {
  const CAP = 20

  it("returns cap when examples is undefined", () => {
    expect(ancestryPenalty(undefined, new Map(), CAP)).toBe(CAP)
  })

  it("returns cap when examples is empty", () => {
    expect(ancestryPenalty([], new Map(), CAP)).toBe(CAP)
  })

  it("returns cap for legacy string[] examples (unknown weights)", () => {
    expect(ancestryPenalty(["a", "b"], new Map([["a", 100]]), CAP)).toBe(CAP)
  })

  it("returns 0 for a single weight=1 example at 100 health", () => {
    const examples = [{ cellId: "a", weight: 1 }]
    const healthMap = new Map([["a", 100]])
    expect(ancestryPenalty(examples, healthMap, CAP)).toBe(0)
  })

  it("scales linearly with weighted average example health", () => {
    const examples = [{ cellId: "a", weight: 1 }]
    const healthMap = new Map([["a", 50]])
    expect(ancestryPenalty(examples, healthMap, CAP)).toBe(CAP * 0.5)
  })

  it("a high-coverage example dominates many thin ones", () => {
    const examples = [
      { cellId: "a", weight: 0.8 },
      ...Array.from({ length: 9 }, (_, i) => ({ cellId: `b${i}`, weight: 0.02 })),
    ]
    const healthMap = new Map<string, number>([
      ["a", 100],
      ...Array.from({ length: 9 }, (_, i) => [`b${i}`, 15] as [string, number]),
    ])
    const result = ancestryPenalty(examples, healthMap, CAP)
    expect(result).toBeLessThan(2)  // weighted avg ≈ 95 → penalty ≈ 1
  })

  it("treats missing examples in healthMap as 0 health", () => {
    const examples = [{ cellId: "missing", weight: 1 }]
    const healthMap = new Map<string, number>()
    expect(ancestryPenalty(examples, healthMap, CAP)).toBe(CAP)
  })
})
