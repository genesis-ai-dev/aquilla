// src/lib/codex-editor/merge/__test__/strategies.test.ts
import { describe, it, expect } from "vitest"
import { Strategy, determineStrategy } from "../strategies"

describe("determineStrategy", () => {
  it("routes .codex files to CODEX", () => {
    expect(determineStrategy("files/target/gen.codex")).toBe(Strategy.CODEX)
    expect(determineStrategy("/files/target/gen.codex")).toBe(Strategy.CODEX)
  })

  it("routes .source files to CODEX", () => {
    expect(determineStrategy(".project/sourceTexts/gen.source")).toBe(Strategy.CODEX)
  })

  it("routes comments.json to COMMENTS", () => {
    expect(determineStrategy(".project/comments.json")).toBe(Strategy.COMMENTS)
  })

  it("routes metadata.json to METADATA", () => {
    expect(determineStrategy("metadata.json")).toBe(Strategy.METADATA)
    expect(determineStrategy("/metadata.json")).toBe(Strategy.METADATA)
  })

  it("routes .vscode/settings.json to JSON_MERGE", () => {
    expect(determineStrategy(".vscode/settings.json")).toBe(Strategy.JSON_MERGE)
  })

  it("routes complete_drafts.txt to IGNORE", () => {
    expect(determineStrategy("complete_drafts.txt")).toBe(Strategy.IGNORE)
  })

  it("falls back to JSON_MERGE for unknown .json", () => {
    expect(determineStrategy("foo/bar.json")).toBe(Strategy.JSON_MERGE)
  })

  it("falls back to OVERRIDE for unknown non-json", () => {
    expect(determineStrategy("files/media/clip.mp4")).toBe(Strategy.OVERRIDE)
  })

  it("normalizes backslash path separators", () => {
    expect(determineStrategy("files\\target\\gen.codex")).toBe(Strategy.CODEX)
  })
})
