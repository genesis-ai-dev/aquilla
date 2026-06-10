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

// FRO-181: serverRollup override — AD-14 amendment 2026-06-04.
describe("useHealth — serverRollup override (FRO-181)", () => {
  it("uses server projectHealth when serverRollup is provided", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 0)]]])
    // endorsement-count path gives 0; server says 75.
    const serverRollup = { projectHealth: 75, fileHealth: new Map([["f", 75]]) }
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { serverRollup }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.projectHealth).toBe(75)
  })

  it("uses server fileHealth when serverRollup is provided", async () => {
    const fileCells = new Map([
      ["f1", [cell("a", "hello", 0)]],
      ["f2", [cell("b", "world", 0)]],
    ])
    const serverRollup = {
      projectHealth: 60,
      fileHealth: new Map([["f1", 80], ["f2", 40]]),
    }
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { serverRollup }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(2))
    expect(result.current.fileHealth.get("f1")).toBe(80)
    expect(result.current.fileHealth.get("f2")).toBe(40)
  })

  it("falls back to endorsement-count health when serverRollup is null", async () => {
    // cell with 5 endorsements at gate 5 → health 100.
    const fileCells = new Map([["f", [cell("a", "bonjour", 5)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { requiredValidations: 5, serverRollup: null }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.projectHealth).toBe(100)
  })

  it("falls back to endorsement-count health when serverRollup.projectHealth is null", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 5)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], {
        requiredValidations: 5,
        serverRollup: { projectHealth: null, fileHealth: new Map() },
      }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.projectHealth).toBe(100) // endorsement-count path: 5/5 → 100
  })
})
