import { describe, it, expect } from "vitest"
import { runCheck } from "./empty-target"

describe("empty-target", () => {
  it("flags non-empty source with empty target", () => {
    expect(runCheck("Hello world", "")).not.toBeNull()
  })

  it("flags non-empty source with whitespace-only target", () => {
    expect(runCheck("Hello world", "   \n\t")).not.toBeNull()
  })

  it("does not flag when both source and target are empty", () => {
    expect(runCheck("", "")).toBeNull()
  })

  it("does not flag when target has content", () => {
    expect(runCheck("Hello", "Bonjour")).toBeNull()
  })

  it("returns a target span covering the cell", () => {
    const spans = runCheck("Hello", "")
    expect(spans).toEqual([{ side: "target", start: 0, end: 0, matchedText: "" }])
  })
})
