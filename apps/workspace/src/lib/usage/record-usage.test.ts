import { describe, it, expect } from "vitest"
import { addLlmCall, addFixApplied } from "./record-usage"
import type { ProjectRecord } from "@/lib/parsers/types"

function baseProject(): ProjectRecord {
  return {
    id: "p1", name: "Demo", sourceLanguage: "en", targetLanguage: "fr",
    files: [], members: [], createdAt: "2026-04-21T00:00:00Z", updatedAt: "2026-04-21T00:00:00Z",
  } as ProjectRecord
}

describe("addLlmCall", () => {
  it("initializes usage when absent", () => {
    const p = addLlmCall(baseProject(), { kind: "autofix-batch-regex", model: "opus-4-7", provider: "frontier" })
    expect(p.usage?.llmCalls["autofix-batch-regex"]).toEqual({
      total: 1,
      byModel: { "opus-4-7": 1 },
      byProvider: { frontier: 1 },
    })
    expect(p.usage?.fixesApplied).toBe(0)
  })

  it("increments existing counters", () => {
    const initial = addLlmCall(baseProject(), { kind: "rule-suggestion", model: "m", provider: "custom" })
    const next = addLlmCall(initial, { kind: "rule-suggestion", model: "m", provider: "custom" })
    expect(next.usage?.llmCalls["rule-suggestion"].total).toBe(2)
    expect(next.usage?.llmCalls["rule-suggestion"].byModel.m).toBe(2)
    expect(next.usage?.llmCalls["rule-suggestion"].byProvider.custom).toBe(2)
  })

  it("tracks multiple kinds and models", () => {
    let p = addLlmCall(baseProject(), { kind: "autofix-batch-regex", model: "a", provider: "frontier" })
    p = addLlmCall(p, { kind: "autofix-surgical", model: "b", provider: "frontier" })
    p = addLlmCall(p, { kind: "autofix-batch-regex", model: "a", provider: "custom" })
    expect(Object.keys(p.usage!.llmCalls).sort()).toEqual(["autofix-batch-regex", "autofix-surgical"])
    expect(p.usage!.llmCalls["autofix-batch-regex"].byProvider).toEqual({ frontier: 1, custom: 1 })
  })

  it("handles missing model gracefully", () => {
    const p = addLlmCall(baseProject(), { kind: "autofix-batch-regex", provider: "frontier" })
    expect(p.usage?.llmCalls["autofix-batch-regex"].byModel).toEqual({ "(default)": 1 })
  })
})

describe("addFixApplied", () => {
  it("increments from zero", () => {
    const p = addFixApplied(baseProject())
    expect(p.usage?.fixesApplied).toBe(1)
  })

  it("accumulates", () => {
    const p = addFixApplied(addFixApplied(baseProject()))
    expect(p.usage?.fixesApplied).toBe(2)
  })

  it("preserves existing llmCalls", () => {
    const p1 = addLlmCall(baseProject(), { kind: "x", model: "m", provider: "frontier" })
    const p2 = addFixApplied(p1)
    expect(p2.usage?.llmCalls.x.total).toBe(1)
    expect(p2.usage?.fixesApplied).toBe(1)
  })
})
