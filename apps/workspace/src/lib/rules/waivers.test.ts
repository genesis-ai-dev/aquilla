import { describe, it, expect } from "vitest"
import { isWaived, addWaiver, removeWaiver, partitionInfractions } from "./waivers"
import type { RuleWaiver, RuleInfraction } from "@/lib/parsers/types"

const waiver = (ruleId: string, extra: Partial<RuleWaiver> = {}): RuleWaiver => ({
  ruleId, waivedAt: "2026-04-24T00:00:00Z", ...extra,
})
const inf = (ruleId: string): RuleInfraction => ({
  ruleId, cellId: "c1", fileId: "f1", message: "", spans: [],
})

describe("isWaived", () => {
  it("returns true when a waiver exists for the rule", () => {
    expect(isWaived([waiver("r1")], "r1")).toBe(true)
  })
  it("returns false when no waiver matches", () => {
    expect(isWaived([waiver("r2")], "r1")).toBe(false)
    expect(isWaived(undefined, "r1")).toBe(false)
  })
})

describe("addWaiver", () => {
  it("appends a new waiver", () => {
    const next = addWaiver([], { ruleId: "r1", reason: "ok here" }, "alice", "2026-04-24T12:00:00Z")
    expect(next).toEqual([{ ruleId: "r1", reason: "ok here", waivedBy: "alice", waivedAt: "2026-04-24T12:00:00Z" }])
  })
  it("replaces an existing waiver for the same rule", () => {
    const prev = [waiver("r1", { reason: "old" })]
    const next = addWaiver(prev, { ruleId: "r1", reason: "new" }, "alice", "2026-04-24T12:00:00Z")
    expect(next).toHaveLength(1)
    expect(next[0].reason).toBe("new")
  })
})

describe("removeWaiver", () => {
  it("removes a matching waiver", () => {
    const next = removeWaiver([waiver("r1"), waiver("r2")], "r1")
    expect(next).toEqual([waiver("r2")])
  })
  it("is a no-op when no waiver matches", () => {
    const prev = [waiver("r2")]
    const next = removeWaiver(prev, "r1")
    expect(next).toBe(prev)
  })
})

describe("partitionInfractions", () => {
  it("splits infractions into active and waived", () => {
    const infractions = [inf("r1"), inf("r2"), inf("r3")]
    const waivers = [waiver("r2")]
    expect(partitionInfractions(infractions, waivers)).toEqual({
      active: [inf("r1"), inf("r3")],
      waived: [inf("r2")],
    })
  })
})
