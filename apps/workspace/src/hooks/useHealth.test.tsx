import { describe, it, expect } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useHealth } from "./useHealth"
import type { CellData } from "./useCells"

function cell(id: string, translated: string, endorsementCount = 0): CellData {
  return {
    id, cellLabel: id, original: "hi", originalHtml: undefined, translated,
    context: "", group: "", type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: translated ? "none" : "empty",
    endorsementCount,
    activeValidators: [], history: [], threads: [], validationHistory: [],
  } as unknown as CellData
}

describe("useHealth — AD-14 decay", () => {
  it("derives per-cell health from endorsement_count (decay), not the four-sub-score", async () => {
    const fileCells = new Map([
      ["f", [cell("a", "bonjour", 5), cell("b", "salut", 0)]],
    ])
    const { result } = renderHook(() => useHealth(fileCells, []))
    await waitFor(() => expect(result.current.healthMap.size).toBe(2))
    // endorsementCount 5 (target) → decay 0 → health 100; 0 → decay 1 → health 0.
    expect(result.current.healthMap.get("a")).toBe(100)
    expect(result.current.healthMap.get("b")).toBe(0)
  })

  it("retires the four-sub-score breakdown (breakdownMap always empty)", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 3)]]])
    const { result } = renderHook(() => useHealth(fileCells, []))
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.breakdownMap.size).toBe(0)
  })
})
