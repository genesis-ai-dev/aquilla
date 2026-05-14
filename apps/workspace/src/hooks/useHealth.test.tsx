import { describe, it, expect } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useHealth } from "./useHealth"
import type { CellData } from "./useCells"

function cell(id: string, original: string, translated: string): CellData {
  return {
    id, cellLabel: id, original, originalHtml: undefined, translated,
    context: "", group: "", type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: translated ? "none" : "empty",
    activeValidators: [], history: [], threads: [], validationHistory: [],
  } as unknown as CellData
}

describe("useHealth flag dispatch", () => {
  it("legacy path returns breakdownMap = empty Map when flag off", async () => {
    const fileCells = new Map([["f", [cell("a", "hi", "bonjour")]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, 0.1, [], { major: 15, minor: 5 }, { composite: false })
    )
    await waitFor(() => expect(result.current.healthMap.size).toBeGreaterThanOrEqual(0))
    expect(result.current.breakdownMap.size).toBe(0)
  })

  it("composite path returns breakdownMap populated when flag on", async () => {
    const fileCells = new Map([["f", [cell("a", "hi", "bonjour")]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, 0.1, [], { major: 15, minor: 5 }, { composite: true })
    )
    await waitFor(() => expect(result.current.breakdownMap.size).toBeGreaterThan(0))
  })
})
