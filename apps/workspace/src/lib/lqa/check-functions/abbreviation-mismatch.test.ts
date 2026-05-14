import { describe, it, expect } from "vitest"
import { runCheck } from "./abbreviation-mismatch"

describe("abbreviation-mismatch", () => {
  it("flags missing abbreviation", () => {
    const spans = runCheck("USA is large", "Les États-Unis sont grands")
    expect(spans).not.toBeNull()
    expect(spans![0].matchedText).toBe("USA")
  })

  it("returns null when abbreviation present", () => {
    expect(runCheck("USA is large", "USA est grand")).toBeNull()
  })

  it("ignores single-letter caps (likely sentence start)", () => {
    expect(runCheck("A house", "Une maison")).toBeNull()
  })

  it("returns null when source has no abbreviations", () => {
    expect(runCheck("Hello world", "Bonjour monde")).toBeNull()
  })
})
