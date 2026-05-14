// Phase 2b: waivers are stubbed (v1 event grammar doesn't carry waiver
// events). Tests assert that the stub returns empty + no-ops; the round-trip
// test from the old Y.Doc-backed version is gone with this migration.

import { describe, it, expect } from "vitest"
import { readCellWaivers, setCellWaivers } from "./useCellWaivers"
import type { RuleWaiver } from "@/lib/parsers/types"

describe("cell waivers (Phase 2b stub)", () => {
  it("readCellWaivers returns an empty array regardless of input", () => {
    expect(readCellWaivers(null, "c1")).toEqual([])
    expect(readCellWaivers({}, "c1")).toEqual([])
    expect(readCellWaivers({}, "missing")).toEqual([])
  })

  it("setCellWaivers is a no-op (does not throw) and does not surface side effects via read", () => {
    const waiver: RuleWaiver = { ruleId: "r1", waivedAt: "2026-04-24T00:00:00Z" }
    expect(() => setCellWaivers(null, "c1", [waiver])).not.toThrow()
    expect(readCellWaivers(null, "c1")).toEqual([])
  })
})
