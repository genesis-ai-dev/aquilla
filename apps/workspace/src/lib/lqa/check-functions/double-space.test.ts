import { describe, it, expect } from "vitest"
import { runCheck } from "./double-space"

describe("double-space", () => {
  it("flags consecutive spaces", () => {
    const spans = runCheck("Hello world", "Bonjour  monde")
    expect(spans).not.toBeNull()
    expect(spans![0].matchedText).toBe("  ")
  })

  it("flags leading whitespace", () => {
    expect(runCheck("Hello", " Bonjour")).not.toBeNull()
  })

  it("flags trailing whitespace", () => {
    expect(runCheck("Hello", "Bonjour ")).not.toBeNull()
  })

  it("returns null when source has matching double space (intentional)", () => {
    expect(runCheck("col1  col2", "col1  col2")).toBeNull()
  })

  it("returns null on clean target", () => {
    expect(runCheck("Hello world", "Bonjour monde")).toBeNull()
  })
})
