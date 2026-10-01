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

  // The org setting (Sam, 2026-10-01). Off by default — the test above is the
  // default — and turning it on lets the draft through without loosening the
  // other two conditions.
  it("lets an untouched AI draft through only when the org allows it", () => {
    const draft = { translated: "Machine draft", targetEventId: "event-1", aiDrafted: true }
    expect(isBulkValidationEligible(draft, {})).toBe(false)
    expect(isBulkValidationEligible(draft, { allowAiDrafts: false })).toBe(false)
    expect(isBulkValidationEligible(draft, { allowAiDrafts: true })).toBe(true)
    expect(isBulkValidationEligible({ ...draft, translated: " " }, { allowAiDrafts: true })).toBe(false)
    expect(isBulkValidationEligible({ ...draft, targetEventId: null }, { allowAiDrafts: true })).toBe(false)
  })
})
