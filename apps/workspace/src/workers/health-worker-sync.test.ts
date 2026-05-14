import { describe, it, expect } from "vitest"
import { computeHealthSync, type HealthSyncRequest } from "./health-worker-sync"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"
import type { CellHistoryEntry } from "@/lib/parsers/types"

type TestCell = HealthSyncRequest["cells"][number]

function mkCell(
  id: string,
  original: string,
  translated: string,
  validatorCount = 0,
  history: CellHistoryEntry[] = [],
  fileId = "f1",
): TestCell {
  return { id, fileId, original, translated, validatorCount, history }
}

describe("computeHealthSync", () => {
  it("returns empty maps for zero cells", () => {
    const r = computeHealthSync({
      cells: [], rules: [], config: HEALTH_DEFAULTS, requiredValidations: 2,
    })
    expect(r.healthMap.size).toBe(0)
    expect(r.breakdownMap.size).toBe(0)
    expect(r.projectHealth).toBe(0)
  })

  it("full round-trip: translated cells score; empty cells skipped", () => {
    const r = computeHealthSync({
      cells: [
        mkCell("a", "hello world", "bonjour monde", 2),
        mkCell("b", "goodbye", ""),  // empty translation
        mkCell("c", "hello moon", "bonjour lune", 0),
      ],
      rules: [],
      config: HEALTH_DEFAULTS,
      requiredValidations: 2,
    })
    expect(r.healthMap.has("a")).toBe(true)
    expect(r.healthMap.has("b")).toBe(false)
    expect(r.healthMap.has("c")).toBe(true)
    // 'a' fully validated — consistency penalty may still reduce it, but score > 0
    expect(r.healthMap.get("a")!).toBeGreaterThan(0)
  })
})
