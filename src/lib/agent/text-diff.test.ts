/**
 * text-diff tests — the LCS line-diff BriefPanel uses to render proposed
 * brief updates (mem-M2/M3): unchanged lines stay "context", and additions
 * / removals are reported in the right order and kind.
 */

import { describe, it, expect } from "vitest"
import { diffLines, hasChanges } from "./text-diff"

describe("diffLines", () => {
  it("reports no changes for identical text", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc")
    expect(lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "context", text: "c" },
    ])
    expect(hasChanges(lines)).toBe(false)
  })

  it("marks an appended line as added, keeping prior lines as context", () => {
    const lines = diffLines("a\nb", "a\nb\nc")
    expect(lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "added", text: "c" },
    ])
    expect(hasChanges(lines)).toBe(true)
  })

  it("marks a removed line as removed", () => {
    const lines = diffLines("a\nb\nc", "a\nc")
    expect(lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "context", text: "c" },
    ])
  })

  it("pairs a same-position edit as a removed line followed by an added line", () => {
    const lines = diffLines("The tone is casual.", "The tone is formal.")
    expect(lines).toEqual([
      { kind: "removed", text: "The tone is casual." },
      { kind: "added", text: "The tone is formal." },
    ])
  })

  it("handles an empty before (whole brief is new)", () => {
    const lines = diffLines("", "new content")
    expect(lines).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "new content" },
    ])
  })
})
