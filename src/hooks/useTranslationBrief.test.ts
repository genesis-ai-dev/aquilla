// src/hooks/useTranslationBrief.test.ts
import { describe, it, expect, vi } from "vitest"
import { buildSavePayload, withGeneratedL1 } from "./useTranslationBrief"
import { emptyBrief } from "@/lib/brief/brief"

describe("buildSavePayload", () => {
  it("bumps version, refreshes updatedAt/updatedBy, reassembles L2", () => {
    const prev = emptyBrief("alice")
    const next = buildSavePayload(prev, { parameters: { purpose: "Evangelistic" }, freeformNotes: "" }, "bob")
    expect(next.version).toBe(prev.version + 1)
    expect(next.updatedBy).toBe("bob")
    expect(next.updatedAt >= prev.updatedAt).toBe(true)
    expect(next.l2Markdown).toContain("Evangelistic")
    expect(next.parameters.purpose).toBe("Evangelistic")
  })
})

describe("withGeneratedL1", () => {
  it("stamps l1GeneratedAt === updatedAt so the result is not stale", () => {
    const saved = buildSavePayload(emptyBrief("a"), { parameters: { purpose: "p" }, freeformNotes: "" }, "a")
    const out = withGeneratedL1(saved, "Be evangelistic.", "claude")
    expect(out.l1Summary).toBe("Be evangelistic.")
    expect(out.l1ModelId).toBe("claude")
    expect(out.l1GeneratedAt).toBe(out.updatedAt)
  })
})
