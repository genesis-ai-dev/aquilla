import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONFIDENCE_RESCORE_DEBOUNCE_MS, useCellConfidence } from "./useCellConfidence"
import { CellStore, type CellSummary } from "./useActiveCellStore"
import type { CellRow } from "@/lib/sync/cells-read-types"

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
  it("reuses preparation across focus and response renders and skips disabled files", async () => {
    const cells = Array.from({ length: 31_215 }, (_, i) => cell(`c${i}`, "", "empty"))
    cells[0] = cell("c0", "draft")
    Object.defineProperty(cells[0], "status", { get: () => "unvalidated", configurable: true })
    const readStatus = vi.spyOn(cells[0], "status", "get")
    let enabled = false
    let focusedCellId: string | null = null
    const { rerender } = renderHook(() => useCellConfidence({ ...base, cells, enabled, focusedCellId }))
    expect(readStatus).not.toHaveBeenCalled()
    enabled = true
    rerender()
    await act(async () => { await Promise.resolve() })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(1)
    readStatus.mockClear()
    focusedCellId = "c0"
    rerender()
    focusedCellId = null
    rerender()
    // Effect still updates local validation on focus, but preparation must not
    // scan original/translated text or repeat the three status filters.
    expect(readStatus.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it("observes fresh source and target text from real CellStore snapshots", async () => {
    const store = new CellStore()
    store.setRuntime({ projectId: "p1", fileId: "f1", username: "alice", requiredValidations: 1, auditStats: new Map() })
    const row = (side: "source" | "target", value: string): CellRow => ({
      cellId: "c1", side, targetLang: "", value, valueHtml: null,
      type: "verse", canonicalRef: "GEN 1:1", anchorCellId: null,
      eventId: `${side}-${value}`, sourceEventId: null,
      lastEditor: "bob", lastEditAt: 1, validated: false, wordCount: 1,
    })
    store.replaceRows([row("source", "Original"), row("target", "Draft")])
    const initial = store.getAllSummaries()
    const { rerender } = renderHook(() => useCellConfidence({ ...base, cells: store.getAllSummaries() }))
    await act(async () => { await Promise.resolve() })
    expect(fetchCellConfidence).toHaveBeenCalledTimes(1)
    expect(fetchCellConfidence.mock.calls[0][0].cellIds).toEqual(["c1"])
    for (const [original, translated] of [["Revised", "Draft"], ["Revised", "New draft"]]) {
      store.replaceRowsForCell("c1", [row("source", original), row("target", translated)])
      expect(store.getAllSummaries()).not.toBe(initial)
      rerender()
      await act(async () => { await vi.advanceTimersByTimeAsync(CONFIDENCE_RESCORE_DEBOUNCE_MS) })
    }
    expect(fetchCellConfidence).toHaveBeenCalledTimes(3)
    expect(initial[0].original).toBe("Original")
    expect(initial[0].translated).toBe("Draft")
  })

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
