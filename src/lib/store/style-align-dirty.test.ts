import { beforeEach, describe, expect, it } from "vitest"
import {
  clearStyleAlignDirty,
  markStyleAlignDirty,
  resetStyleAlignDirtyForTests,
  styleAlignDirtyMatches,
} from "./style-align-dirty"

beforeEach(() => {
  localStorage.clear()
  resetStyleAlignDirtyForTests()
})

describe("style-align dirty marks", () => {
  it("matches only the HTML that was marked, and clears back to absent", () => {
    expect(styleAlignDirtyMatches("cell-1", "<p>Bonjour</p>")).toBe(false)

    markStyleAlignDirty("cell-1", "<p>Bonjour</p>")
    expect(styleAlignDirtyMatches("cell-1", "<p>Bonjour</p>")).toBe(true)
    expect(styleAlignDirtyMatches("cell-1", "<p>Bonjour monde</p>")).toBe(false)
    expect(localStorage.getItem("aq.style-align-dirty.v1")).toContain("cell-1")

    clearStyleAlignDirty("cell-1")
    expect(styleAlignDirtyMatches("cell-1", "<p>Bonjour</p>")).toBe(false)
    expect(localStorage.getItem("aq.style-align-dirty.v1")).toBeNull()
  })
})