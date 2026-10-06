import { describe, expect, it } from "vitest"
import { isBulkValidationEligible } from "./review-eligibility"

describe("isBulkValidationEligible", () => {
  it("allows committed text", () => {
    expect(isBulkValidationEligible({
      translated: "Human translation",
      targetEventId: "event-1",
    })).toBe(true)
  })

  // AQU-1703 regression guard. The old rule excluded `cells.ai_drafted`, which
  // is cleared by a human target COMMIT — so bulk validate covered only lines
  // somebody had retyped, and a reviewer signing off a colleague's AI-assisted
  // work was told the lines were "reviewed one at a time". Provenance is not an
  // eligibility question: a reviewer validating a machine draft is the job.
  it("allows a machine-drafted line that no human has retyped", () => {
    expect(isBulkValidationEligible({
      translated: "Machine draft",
      targetEventId: "event-1",
    })).toBe(true)
  })

  it("blocks empty and uncommitted cells", () => {
    expect(isBulkValidationEligible({ translated: "", targetEventId: "event-1" })).toBe(false)
    expect(isBulkValidationEligible({ translated: "   ", targetEventId: "event-1" })).toBe(false)
    expect(isBulkValidationEligible({ translated: "Text" })).toBe(false)
    expect(isBulkValidationEligible({ translated: "Text", targetEventId: null })).toBe(false)
  })
})
