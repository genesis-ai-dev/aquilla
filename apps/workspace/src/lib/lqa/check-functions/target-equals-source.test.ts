import { describe, it, expect } from "vitest"
import { runCheck } from "./target-equals-source"

describe("target-equals-source", () => {
  it("flags target identical to source", () => {
    expect(runCheck("Hello world", "Hello world")).not.toBeNull()
  })

  it("flags after trimming whitespace differences", () => {
    expect(runCheck("Hello", "  Hello  ")).not.toBeNull()
  })

  it("does not flag different texts", () => {
    expect(runCheck("Hello", "Bonjour")).toBeNull()
  })

  it("does not flag short source (<= 3 chars) — likely a proper noun", () => {
    expect(runCheck("USA", "USA")).toBeNull()
  })

  it("does not flag empty cells", () => {
    expect(runCheck("", "")).toBeNull()
    expect(runCheck("Hello", "")).toBeNull()
  })

  it("returns a target span covering the whole target", () => {
    const spans = runCheck("Hello world", "Hello world")
    expect(spans).toEqual([{ side: "target", start: 0, end: 11, matchedText: "Hello world" }])
  })
})
