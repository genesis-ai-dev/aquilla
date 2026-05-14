import { describe, it, expect } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useCompositeHealth } from "./useCompositeHealth"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"
import type { CellData } from "./useCells"

function cell(partial: Partial<CellData> & { id: string; original: string; translated: string }): CellData {
  return {
    cellLabel: partial.id,
    validationStatus: "none",
    activeValidators: [],
    status: partial.translated ? "unvalidated" : "empty",
    context: "",
    group: "",
    type: "text",
    history: [],
    threads: [],
    validationHistory: [],
    ...partial,
  } as CellData
}

describe("useCompositeHealth (sync path)", () => {
  it("returns an empty response when cells are empty", async () => {
    const { result } = renderHook(() =>
      useCompositeHealth({ fileCells: new Map(), rules: [], config: HEALTH_DEFAULTS, requiredValidations: 2 })
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.stats.healthMap.size).toBe(0)
  })

  it("produces a score for a translated cell", async () => {
    const fileCells = new Map<string, CellData[]>([
      ["f1", [cell({ id: "a", original: "hello", translated: "bonjour" })]],
    ])
    const { result } = renderHook(() =>
      useCompositeHealth({ fileCells, rules: [], config: HEALTH_DEFAULTS, requiredValidations: 2 })
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.stats.healthMap.has("a")).toBe(true)
  })
})
