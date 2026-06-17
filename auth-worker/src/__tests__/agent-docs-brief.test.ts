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
