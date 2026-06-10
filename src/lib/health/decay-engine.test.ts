import { describe, it, expect } from "vitest"
import {
  cellDecay,
  cellHealth,
  needsAttention,
  needsAttentionFromConfidence,
  computeDecayHealth,
  resolveDecayConfig,
  DECAY_DEFAULTS,
  DEFAULT_DECAY_WARN_THRESHOLD,
  CELL_NEEDS_ATTENTION_STATUS,
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

describe("resolveDecayConfig", () => {
  it("defaults the target to the required-validations gate", () => {
    expect(resolveDecayConfig(undefined, 1).endorsementTarget).toBe(1)
    expect(resolveDecayConfig(undefined, 3).endorsementTarget).toBe(3)
  })

  it("clamps a non-positive gate up to 1", () => {
    expect(resolveDecayConfig(undefined, 0).endorsementTarget).toBe(1)
  })

  it("lets an explicit endorsementTarget override the gate", () => {
    expect(resolveDecayConfig({ endorsementTarget: 7 }, 2).endorsementTarget).toBe(7)
  })

  it("defaults the warn threshold but lets it be overridden", () => {
    expect(resolveDecayConfig(undefined, 1).decayWarnThreshold).toBe(DEFAULT_DECAY_WARN_THRESHOLD)
    expect(resolveDecayConfig({ decayWarnThreshold: 0.5 }, 1).decayWarnThreshold).toBe(0.5)
  })

  it("makes a single endorsement fully healthy at a gate of 1", () => {
    const cfg = resolveDecayConfig(undefined, 1)
    expect(cellHealth(1, cfg.endorsementTarget)).toBe(100)
    expect(needsAttention(1, cfg)).toBe(false)
  })
})

// FRO-181: needsAttentionFromConfidence — AD-14 amendment 2026-06-04.
// Uses a server-derived confidence score (0-100) instead of endorsement_count.
describe("needsAttentionFromConfidence (FRO-181)", () => {
  const WARN = DEFAULT_DECAY_WARN_THRESHOLD // 0.66

  it("marks a cell with confidence 0 (decay 1 > 0.66)", () => {
    expect(needsAttentionFromConfidence(0, WARN)).toBe(true)
  })

  it("marks a cell with confidence 33 (decay 0.67 > 0.66)", () => {
    expect(needsAttentionFromConfidence(33, WARN)).toBe(true)
  })

  it("clears a cell with confidence 100 (validated anchor; decay 0)", () => {
    expect(needsAttentionFromConfidence(100, WARN)).toBe(false)
  })

  it("clears a cell with confidence 34 (decay 0.66 = threshold, not above)", () => {
    // decay = 1 - 34/100 = 0.66; threshold is STRICT: decay > 0.66 → false
    expect(needsAttentionFromConfidence(34, WARN)).toBe(false)
  })

  it("marks a cell with confidence 33 against a custom warn of 0.5", () => {
    expect(needsAttentionFromConfidence(33, 0.5)).toBe(true)
  })

  it("clears a cell with confidence 60 against a custom warn of 0.5 (decay 0.4 <= 0.5)", () => {
    expect(needsAttentionFromConfidence(60, 0.5)).toBe(false)
  })
})

// FRO-232: guard the exact user-visible status string shown in the cell popover
// when the cell needs attention. The string must not duplicate "needs attention"
// (the popover header already carries that label) and must use domain vocabulary
// (passage/context rather than "neighborhood").
describe("CELL_NEEDS_ATTENTION_STATUS (FRO-232)", () => {
  it("does not contain the word 'neighborhood'", () => {
    expect(CELL_NEEDS_ATTENTION_STATUS.toLowerCase()).not.toContain("neighborhood")
  })

  it("does not duplicate 'needs attention' within the string", () => {
    const lower = CELL_NEEDS_ATTENTION_STATUS.toLowerCase()
    const firstIdx = lower.indexOf("needs attention")
    const lastIdx = lower.lastIndexOf("needs attention")
    expect(firstIdx).toBe(lastIdx) // only one occurrence (or none at all)
  })

  it("is the expected exact string (FRO-232 regression guard)", () => {
    expect(CELL_NEEDS_ATTENTION_STATUS).toBe(
      "This cell's passage context hasn't been validated yet.",
    )
  })
})
