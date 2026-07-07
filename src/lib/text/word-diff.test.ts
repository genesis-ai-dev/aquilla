import { describe, it, expect } from "vitest"
import { wordDiff } from "./word-diff"

describe("wordDiff", () => {
  it("returns a single equal run for identical text", () => {
    const tokens = wordDiff("hello world", "hello world")
    expect(tokens.every((t) => t.op === "equal")).toBe(true)
    expect(tokens.map((t) => t.text).join("")).toBe("hello world")
  })

  it("marks a changed word as delete+insert around the unchanged parts", () => {
    const tokens = wordDiff("In the beginning", "In the beginning (fixed)")
    const ops = tokens.map((t) => t.op)
    expect(ops).toContain("equal")
    expect(ops).toContain("insert")
    expect(tokens.filter((t) => t.op === "delete")).toHaveLength(0)
  })

  it("marks removed words as delete", () => {
    const tokens = wordDiff("one two three", "one three")
    expect(tokens.some((t) => t.op === "delete" && t.text === "two")).toBe(true)
  })

  it("handles empty old text (first-ever mirror / new line)", () => {
    const tokens = wordDiff("", "brand new content")
    expect(tokens.every((t) => t.op === "insert")).toBe(true)
  })
})
