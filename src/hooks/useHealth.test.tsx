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
    // endorsement >= target → decay 0 → health 100; 0 → decay 1 → health 0.
    expect(result.current.healthMap.get("a")).toBe(100)
    expect(result.current.healthMap.get("b")).toBe(0)
  })

  it("reaches full health at the required-validations gate (default), not a hard-coded 5", async () => {
    // The regression: a cell validated once must read 100 when the project
    // requires a single validation — not stick at 20% against a phantom 5.
    const fileCells = new Map([["f", [cell("a", "bonjour", 1)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { requiredValidations: 1 }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.healthMap.get("a")).toBe(100)
  })

  it("interpolates against the required-validations gate", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 3)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { requiredValidations: 5 }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.healthMap.get("a")).toBe(60) // 3/5 endorsed → decay .4 → health 60
  })

  it("lets an explicit decaySettings.endorsementTarget override the gate", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 1)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], {
        requiredValidations: 1,
        decaySettings: { endorsementTarget: 4 },
      }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.healthMap.get("a")).toBe(25) // 1/4 endorsed → decay .75 → health 25
  })

  it("carries rule infractions as a separate surface (not folded into health)", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 3)]]])
    const { result } = renderHook(() => useHealth(fileCells, []))
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.infractions instanceof Map).toBe(true)
  })
})
