import { describe, expect, it } from "vitest"
import { isBulkValidationEligible } from "./review-eligibility"

describe("isBulkValidationEligible", () => {
  it("allows committed human-reviewed text", () => {
    expect(isBulkValidationEligible({
      translated: "Human translation",
      targetEventId: "event-1",
      aiDrafted: false,
    })).toBe(true)
  })

  it("blocks untouched AI drafts from bulk approval", () => {
    expect(isBulkValidationEligible({
      translated: "Machine draft",
      targetEventId: "event-1",
      aiDrafted: true,
    })).toBe(false)
  })

  it("blocks empty and uncommitted cells", () => {
    expect(isBulkValidationEligible({ translated: "", targetEventId: "event-1" })).toBe(false)
    expect(isBulkValidationEligible({ translated: "Text" })).toBe(false)
  })
})
