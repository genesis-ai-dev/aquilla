import { describe, it, expect } from "vitest"
import {
  cellDecay,
  cellHealth,
  needsAttention,
  computeDecayHealth,
  DECAY_DEFAULTS,
} from "./decay-engine"
import type { CellData } from "@/hooks/useCells"

function cell(id: string, endorsementCount: number): CellData {
  // Only the fields the decay engine reads matter here.
  return { id, endorsementCount } as unknown as CellData
}

describe("cellDecay", () => {
  it("is 1 for an untouched cell (0 endorsements)", () => {
    expect(cellDecay(0, 5)).toBe(1)
  })

  it("reaches 0 at the endorsement target", () => {
    expect(cellDecay(5, 5)).toBe(0)
  })

  it("floors at 0 beyond the target", () => {
    expect(cellDecay(8, 5)).toBe(0)
  })

  it("interpolates linearly", () => {
    expect(cellDecay(2, 5)).toBeCloseTo(0.6)
  })

  it("treats a non-positive target as fully healthy", () => {
    expect(cellDecay(0, 0)).toBe(0)
  })
})

describe("cellHealth", () => {
  it("is 0 for an untouched cell and 100 at target", () => {
    expect(cellHealth(0, 5)).toBe(0)
    expect(cellHealth(5, 5)).toBe(100)
  })
})

describe("needsAttention (defaults: target 5, warn 0.66)", () => {
  it("marks a 1-endorsement cell (decay 0.8 > 0.66)", () => {
    expect(needsAttention(1, DECAY_DEFAULTS)).toBe(true)
  })

  it("clears a 2-endorsement cell (decay 0.6 <= 0.66)", () => {
    expect(needsAttention(2, DECAY_DEFAULTS)).toBe(false)
  })

  it("marks an untouched cell", () => {
    expect(needsAttention(0, DECAY_DEFAULTS)).toBe(true)
  })
})

describe("computeDecayHealth", () => {
  it("computes per-cell, file, and project health = 1 - mean(decay)", () => {
    const fileCells = new Map<string, CellData[]>([
      ["f1", [cell("a", 5), cell("b", 0)]], // decays 0 and 1 → health 100, 0
      ["f2", [cell("c", 5)]], // decay 0 → health 100
    ])
    const { healthMap, fileHealth, projectHealth } = computeDecayHealth(
      fileCells,
      DECAY_DEFAULTS,
    )
    expect(healthMap.get("a")).toBe(100)
    expect(healthMap.get("b")).toBe(0)
    expect(healthMap.get("c")).toBe(100)
    // f1 mean decay = (0 + 1)/2 = 0.5 → health 50
    expect(fileHealth.get("f1")).toBe(50)
    expect(fileHealth.get("f2")).toBe(100)
    // project mean decay = (0 + 1 + 0)/3 ≈ 0.333 → health 67
    expect(projectHealth).toBe(67)
  })

  it("returns 0 health for an empty project", () => {
    expect(computeDecayHealth(new Map(), DECAY_DEFAULTS).projectHealth).toBe(0)
  })
})
