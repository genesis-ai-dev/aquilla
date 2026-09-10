import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONFIDENCE_RESCORE_DEBOUNCE_MS, useCellConfidence } from "./useCellConfidence"
import type { CellSummary } from "./useActiveCellStore"

const fetchCellConfidence = vi.hoisted(() => vi.fn())
vi.mock("@/lib/sync/cell-confidence-read", () => ({ fetchCellConfidence }))

// Every commit / optimistic edit used to fire a fresh POST scoring up to 100
// cells (the abort only cancels the client side — the server had already
// started the FTS5 work). These tests pin the request shaping: immediate on a
// new file, debounced on content churn, and silent while the focused cell is
// the only thing changing.

function cell(id: string, translated: string, status: CellSummary["status"] = "unvalidated"): CellSummary {
  return {
    id,
    fileId: "f1",
    index: Number(id.slice(1)),
    original: `src ${id}`,
    translated,
    context: "",
    group: "",
    type: "text",
    status,
  } as CellSummary
}

const base = { projectId: "p1", fileId: "f1", getToken: async () => "tok", enabled: true }

beforeEach(() => {
  vi.useFakeTimers()
  fetchCellConfidence.mockResolvedValue({ confidence: { c1: 0.5, c2: 0.7 }, detail: {}, tookMs: 3 })
})

afterEach(() => {
  vi.useRealTimers()
  fetchCellConfidence.mockReset()
})

describe("useCellConfidence request shaping", () => {
  it("scores immediately on first enable for a file", async () => {
    renderHook(() => useCellConfidence({ ...base, cells: [cell("c1", "a"), cell("c2", "b")] }))
    await act(async () => { await Promise.resolve() })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(1)
    expect(fetchCellConfidence.mock.calls[0][0].cellIds).toEqual(["c1", "c2"])
  })

  it("debounces content churn into one trailing request", async () => {
    let cells = [cell("c1", "a"), cell("c2", "b")]
    const { rerender } = renderHook(() => useCellConfidence({ ...base, cells }))
    await act(async () => { await Promise.resolve() })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(1)

    // Three commits in quick succession on an unfocused cell.
    for (const text of ["b1", "b2", "b3"]) {
      cells = [cell("c1", "a"), cell("c2", text)]
      rerender()
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    }
    expect(fetchCellConfidence).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIDENCE_RESCORE_DEBOUNCE_MS) })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(2)
  })

  it("does not re-score while only the focused cell's text changes, then scores once focus leaves", async () => {
    let cells = [cell("c1", "a"), cell("c2", "b")]
    let focused: string | null = null
    const { rerender, result } = renderHook(() => useCellConfidence({ ...base, cells, focusedCellId: focused }))
    await act(async () => { await Promise.resolve() })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(1)
    expect(result.current.healthMap.get("c1")).toBe(50)

    focused = "c2"
    rerender()
    for (const text of ["b1", "b2"]) {
      cells = [cell("c1", "a"), cell("c2", text)]
      rerender()
      await act(async () => { await vi.advanceTimersByTimeAsync(CONFIDENCE_RESCORE_DEBOUNCE_MS * 2) })
    }
    expect(fetchCellConfidence).toHaveBeenCalledTimes(1)
    // The overlay keeps the scores it already has while the edit is in progress.
    expect(result.current.healthMap.get("c1")).toBe(50)

    focused = null
    rerender()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIDENCE_RESCORE_DEBOUNCE_MS) })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(2)
  })

  it("still re-scores while a cell is focused when ANOTHER cell changes", async () => {
    let cells = [cell("c1", "a"), cell("c2", "b")]
    const { rerender } = renderHook(() => useCellConfidence({ ...base, cells, focusedCellId: "c2" }))
    await act(async () => { await Promise.resolve() })

    cells = [cell("c1", "a (peer edit)"), cell("c2", "b")]
    rerender()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIDENCE_RESCORE_DEBOUNCE_MS) })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(2)
  })

  it("a validation change re-scores even if the focused cell is the one validated", async () => {
    let cells = [cell("c1", "a"), cell("c2", "b")]
    const { rerender, result } = renderHook(() => useCellConfidence({ ...base, cells, focusedCellId: "c2" }))
    await act(async () => { await Promise.resolve() })

    cells = [cell("c1", "a"), cell("c2", "b", "validated")]
    rerender()
    // Optimistic: the validated cell snaps to 100 before any round-trip.
    expect(result.current.healthMap.get("c2")).toBe(100)
    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIDENCE_RESCORE_DEBOUNCE_MS) })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(2)
    expect(fetchCellConfidence.mock.calls[1][0].cellIds).toEqual(["c1"])
  })

  it("a file switch scores immediately and starts the overlay from scratch", async () => {
    let fileId = "f1"
    const cells = [cell("c1", "a"), cell("c2", "b")]
    const { rerender, result } = renderHook(() => useCellConfidence({ ...base, fileId, cells }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.healthMap.get("c1")).toBe(50)

    fetchCellConfidence.mockResolvedValue({ confidence: {}, detail: {}, tookMs: 1 })
    fileId = "f2"
    rerender()
    await act(async () => { await Promise.resolve() })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(2)
    expect(result.current.healthMap.has("c1")).toBe(false)
  })
})
