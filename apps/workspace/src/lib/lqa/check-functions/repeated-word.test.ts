import { describe, it, expect } from "vitest"
import { runCheck } from "./repeated-word"

describe("repeated-word", () => {
  it("flags repeated adjacent word", () => {
    const spans = runCheck("This is a test", "This is is a test")
    expect(spans).not.toBeNull()
    expect(spans![0].matchedText.toLowerCase()).toContain("is")
  })

  it("is case-insensitive", () => {
    expect(runCheck("Hello", "Hello hello")).not.toBeNull()
  })

  it("suppresses when source has same repetition (genuine repetition)", () => {
    expect(runCheck("Holy holy holy is the Lord", "Saint saint saint est le Seigneur")).toBeNull()
  })

  it("returns null on clean target", () => {
    expect(runCheck("Hello world", "Bonjour monde")).toBeNull()
  })

  it("only flags whole-token matches, not substrings", () => {
    expect(runCheck("Test", "Testing tester")).toBeNull()
  })
})
