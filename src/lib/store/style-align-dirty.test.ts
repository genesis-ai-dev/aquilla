import { beforeEach, describe, expect, it } from "vitest"
import {
  clearManualStyleAlign,
  clearStyleAlignDirty,
  markManualStyleAlign,
  markStyleAlignDirty,
  resetStyleAlignDirtyForTests,
  styleAlignDirtyMatches,
  useManualStyleAlign,
} from "./style-align-dirty"
import { renderHook } from "@testing-library/react"

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

  it("remembers a cell that still needs a manual Align styles pass", () => {
    const { result, rerender } = renderHook(() => useManualStyleAlign("cell-50"))
    expect(result.current).toBe(false)

    markManualStyleAlign("cell-50")
    rerender()
    expect(result.current).toBe(true)
    expect(localStorage.getItem("aq.style-align-manual.v1")).toContain("cell-50")

    clearManualStyleAlign("cell-50")
    rerender()
    expect(result.current).toBe(false)
  })
})