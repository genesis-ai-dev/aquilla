import { describe, it, expect } from "vitest"
import { en } from "@/lib/i18n/messages/en"
import { BRIEF_FIELDS, L1_MAX_CHARS } from "./schema"

describe("BRIEF_FIELDS", () => {
  it("has the 11 spec fields with unique ids", () => {
    const ids = BRIEF_FIELDS.map((f) => f.id)
    expect(ids).toEqual([
      "purpose", "audience", "useAndMedium", "motiveSponsor",
      "sourceTexts", "targetVariety", "registerNaturalness", "literalness",
      "keyTerms", "constraints", "qualityBar",
    ])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("groups the first four under purpose, the rest under standards", () => {
    const byId = Object.fromEntries(BRIEF_FIELDS.map((f) => [f.id, f.group]))
    expect(byId.purpose).toBe("purpose")
    expect(byId.motiveSponsor).toBe("purpose")
    expect(byId.sourceTexts).toBe("standards")
    expect(byId.qualityBar).toBe("standards")
  })

  it("gives every field a labelKey/helperTextKey resolving to non-empty English (the interview needs both)", () => {
    for (const f of BRIEF_FIELDS) {
      expect(String(en[f.labelKey]).trim().length).toBeGreaterThan(0)
      expect(String(en[f.helperTextKey]).trim().length).toBeGreaterThan(0)
    }
  })

  it("caps L1 length to protect the prompt token budget", () => {
    expect(L1_MAX_CHARS).toBe(1600)
  })
})
