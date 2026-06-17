// src/lib/brief/brief.test.ts
import { describe, it, expect } from "vitest"
import { emptyBrief, isL1Stale, briefStatus, filledFieldCount, assembleL2Markdown } from "./brief"
import { BRIEF_FIELDS } from "./schema"
import type { TranslationBrief } from "./types"

function fullParams(): Record<string, string> {
  return Object.fromEntries(BRIEF_FIELDS.map((f) => [f.id, `value for ${f.id}`]))
}

describe("emptyBrief", () => {
  it("creates a blank, never-summarized brief attributed to the author", () => {
    const b = emptyBrief("alice")
    expect(b.version).toBe(0)
    expect(b.updatedBy).toBe("alice")
    expect(b.parameters).toEqual({})
    expect(b.l1Summary).toBeNull()
    expect(b.l1GeneratedAt).toBeNull()
    expect(b.updatedAt).toMatch(/Z$/) // ISO UTC
  })
})

describe("filledFieldCount", () => {
  it("counts only non-empty trimmed schema fields", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "x", audience: "   ", keyTerms: "y" } }
    expect(filledFieldCount(b)).toBe(2) // audience is whitespace-only
  })
})

describe("isL1Stale", () => {
  it("is stale when L1 was never generated", () => {
    expect(isL1Stale(emptyBrief("a"))).toBe(true)
  })
  it("is stale when content changed after L1 generation", () => {
    const b: TranslationBrief = { ...emptyBrief("a"), l1Summary: "s", l1GeneratedAt: "2026-06-17T10:00:00.000Z", updatedAt: "2026-06-17T11:00:00.000Z" }
    expect(isL1Stale(b)).toBe(true)
  })
  it("is fresh when L1 was generated on the latest save", () => {
    const b: TranslationBrief = { ...emptyBrief("a"), l1Summary: "s", l1GeneratedAt: "2026-06-17T11:00:00.000Z", updatedAt: "2026-06-17T11:00:00.000Z" }
    expect(isL1Stale(b)).toBe(false)
  })
})

describe("briefStatus", () => {
  it("none when absent", () => {
    expect(briefStatus(null)).toBe("none")
    expect(briefStatus(undefined)).toBe("none")
  })
  it("draft when partially filled", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "x" } }
    expect(briefStatus(b)).toBe("draft")
  })
  it("draft when all fields filled but L1 missing/stale", () => {
    const b = { ...emptyBrief("a"), parameters: fullParams() }
    expect(briefStatus(b)).toBe("draft")
  })
  it("complete only when every field filled and a current L1 exists", () => {
    const b: TranslationBrief = { ...emptyBrief("a"), parameters: fullParams(), l1Summary: "s", l1GeneratedAt: "2026-06-17T11:00:00.000Z", updatedAt: "2026-06-17T11:00:00.000Z" }
    expect(briefStatus(b)).toBe("complete")
  })
})

describe("assembleL2Markdown", () => {
  it("renders filled fields under group headings and omits empty ones", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "Evangelistic", literalness: "Functional" }, freeformNotes: "Avoid archaic words." }
    const md = assembleL2Markdown(b)
    expect(md).toContain("# Translation Brief")
    expect(md).toContain("## Purpose & audience")
    expect(md).toContain("### Purpose / skopos")
    expect(md).toContain("Evangelistic")
    expect(md).not.toContain("### Audience / addressees") // empty → omitted
    expect(md).toContain("## Additional notes")
    expect(md).toContain("Avoid archaic words.")
  })
  it("omits the notes section when there are no notes", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "x" } }
    expect(assembleL2Markdown(b)).not.toContain("## Additional notes")
  })
})
