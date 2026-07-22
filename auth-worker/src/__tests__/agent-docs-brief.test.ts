import { describe, it, expect } from "vitest"
import { getCookbook, COOKBOOK_TOPICS } from "../lib/agent/docs"

describe("brief cookbook", () => {
  it("is a registered topic", () => {
    expect(COOKBOOK_TOPICS).toContain("brief")
  })
  it("returns a recipe that reads translationBrief from project_settings", () => {
    const { ok, text } = getCookbook("brief")
    expect(ok).toBe(true)
    expect(text).toContain("translationBrief")
    expect(text).toContain("project_settings")
    expect(text).toContain("l2Markdown")
  })
})

describe("validation cookbook — semantics (AQU-622)", () => {
  it("is a registered topic", () => {
    expect(COOKBOOK_TOPICS).toContain("validation")
  })
  it("explains that validation is a human sign-off, not a machine quality score", () => {
    const { ok, text } = getCookbook("validation")
    expect(ok).toBe(true)
    const lower = text.toLowerCase()
    // Answers the tester question: "my correct AI translation is not validated — why?"
    expect(lower).toContain("human sign-off")
    expect(lower).toContain("ai_drafted")
    // The corrected behaviour: an unedited-but-correct AI draft is expected to
    // stay not-validated until a human explicitly validates it.
    expect(lower).toContain("not validated")
    expect(lower).toContain("expected")
    expect(lower).toContain("validating an unedited-but-correct ai draft")
  })
})
