import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CellData } from "./useCells"
import { useCharacterSheetCells } from "./useCharacterSheetCells"

const closed = { timeline: false, importDialog: false, review: false, linkedAudio: false }
const first: CellData[] = [{
  id: "a", fileId: "f", original: "Source", translated: "", context: "", group: "",
  type: "text", status: "empty", validationStatus: "empty", activeValidators: [],
  validationHistory: [], history: [], threads: [], metadata: { cast_name: "Alice" },
}]
const updated: CellData[] = [{ ...first[0], metadata: { cast_name: "Bob" } }]

describe("character sheet view demand", () => {
  it("does not materialize views during ordinary text saves", () => {
    const store = { getAllCellViews: vi.fn(() => first) }
    const { result, rerender } = renderHook(({ version }) => useCharacterSheetCells(store, version, closed), {
      initialProps: { version: 1 },
    })
    const empty = result.current
    rerender({ version: 2 })
    expect(result.current).toBe(empty)
    expect(result.current).toEqual([])
    expect(store.getAllCellViews).not.toHaveBeenCalled()
  })

  it.each(["timeline", "importDialog", "review", "linkedAudio"] as const)(
    "reads current data when %s opens, follows edits and refreshes after reopening",
    consumer => {
      const store = { getAllCellViews: vi.fn(() => first) }
      const { result, rerender } = renderHook(({ version, open }) => useCharacterSheetCells(
        store, version, { ...closed, [consumer]: open },
      ), { initialProps: { version: 1, open: false } })
      rerender({ version: 1, open: true })
      expect(result.current).toBe(first)
      store.getAllCellViews.mockReturnValue(updated)
      rerender({ version: 2, open: true })
      expect(result.current).toBe(updated)
      rerender({ version: 2, open: false })
      expect(result.current).toEqual([])
      store.getAllCellViews.mockClear()
      store.getAllCellViews.mockReturnValue(first)
      rerender({ version: 3, open: false })
      expect(store.getAllCellViews).not.toHaveBeenCalled()
      rerender({ version: 3, open: true })
      expect(result.current).toBe(first)
      expect(store.getAllCellViews).toHaveBeenCalledTimes(1)
    },
  )
})
