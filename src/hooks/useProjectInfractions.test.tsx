/**
 * AQU-1864 — the rules pane's project-wide scan must not run during render,
 * must publish progressively, and must survive the corpus being republished
 * on every outbox change without re-scanning the project.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useProjectInfractions } from "./useProjectInfractions"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import type { TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

const checkSpy = vi.hoisted(() => vi.fn())
vi.mock("@/lib/rules/rule-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rules/rule-engine")>()
  checkSpy.mockImplementation(actual.checkRulesForCell)
  return { ...actual, checkRulesForCell: (...args: Parameters<typeof actual.checkRulesForCell>) => checkSpy(...args) }
})

function makeCell(id: string, translated: string): CellData {
  return {
    id, fileId: "f1", original: "source text", translated,
    context: "", group: "", type: "text",
    status: "unvalidated", validationStatus: "none", activeValidators: [],
    validationHistory: [], history: [], threads: [],
  }
}

const rule: TranslationRule = {
  id: "r1", name: "No bad", description: "", severity: "major", source: "user",
  scope: "project", enabled: true, createdAt: "2026-10-10T00:00:00.000Z",
  check: { type: "target-forbids", targetPattern: "bad" },
}

/** Every cell violates, so counts are easy to read off the map's size. */
function corpus(size: number): CellData[] {
  return Array.from({ length: size }, (_, i) => makeCell(`c${i}`, `bad ${i}`))
}

/** Run queued slices until the scan settles (or the budget is exhausted). */
async function drain(max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  // Force the setTimeout path: requestIdleCallback is not driven by fake
  // timers, and happy-dom does not provide it in the first place.
  vi.stubGlobal("requestIdleCallback", undefined)
  // Fake timers freeze performance.now(), which would make every slice run to
  // completion and hide the slicing this hook exists for. A monotonic clock
  // that advances 5 ms per reading puts the slice boundary at a known place.
  let clock = 0
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 5))
  checkSpy.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("useProjectInfractions", () => {
  it("evaluates nothing during the render pass", () => {
    const cells = corpus(500)
    const { result } = renderHook(() => useProjectInfractions(cells, [rule]))
    expect(checkSpy).not.toHaveBeenCalled()
    expect(result.current.infractions.size).toBe(0)
    expect(result.current.scanning).toBe(true)
    expect(result.current.pending).toBe(500)
  })

  it("fills in counts progressively and ends on the eager answer", async () => {
    const cells = corpus(500)
    const { result } = renderHook(() => useProjectInfractions(cells, [rule]))

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const afterOneSlice = result.current.infractions.size
    expect(afterOneSlice).toBeGreaterThan(0)
    expect(afterOneSlice).toBeLessThan(cells.length)

    await drain()
    expect(result.current.infractions.size).toBe(cells.length)
    expect(result.current.scanning).toBe(false)
    expect(result.current.pending).toBe(0)
    for (const cell of cells) {
      expect(result.current.infractions.get(cell.id)).toEqual(
        checkRulesForCell(cell, cell.fileId, [rule]),
      )
    }
  })

  it("re-scans only the changed cell when the corpus is republished", async () => {
    const cells = corpus(100)
    const { result, rerender } = renderHook(
      ({ c }: { c: CellData[] }) => useProjectInfractions(c, [rule]),
      { initialProps: { c: cells } },
    )
    await drain()
    expect(checkSpy).toHaveBeenCalledTimes(100)
    checkSpy.mockClear()

    // An outbox change republishes the whole corpus as new objects.
    const republished = cells.map((cell) =>
      cell.id === "c3" ? { ...cell, translated: "now clean" } : { ...cell },
    )
    rerender({ c: republished })
    await drain()

    expect(checkSpy).toHaveBeenCalledTimes(1)
    expect(checkSpy.mock.calls[0][0].id).toBe("c3")
    expect(result.current.infractions.has("c3")).toBe(false)
    expect(result.current.infractions.size).toBe(99)
  })

  it("keeps the counts it already has while a republished corpus is rescanned", async () => {
    const cells = corpus(100)
    const { result, rerender } = renderHook(
      ({ c }: { c: CellData[] }) => useProjectInfractions(c, [rule]),
      { initialProps: { c: cells } },
    )
    await drain()
    expect(result.current.infractions.size).toBe(100)

    rerender({ c: cells.map((cell) => ({ ...cell, hasPendingEdit: true })) })
    // Synchronously after the republish, before any slice runs.
    expect(result.current.infractions.size).toBe(100)
    expect(result.current.pending).toBe(0)
  })

  it("re-scans the project when a rule body changes, but not when the array is merely rebuilt", async () => {
    const cells = corpus(20)
    const { result, rerender } = renderHook(
      ({ rules }: { rules: TranslationRule[] }) => useProjectInfractions(cells, rules),
      { initialProps: { rules: [rule] } },
    )
    await drain()
    expect(checkSpy).toHaveBeenCalledTimes(20)
    checkSpy.mockClear()

    // useRules rebuilds its arrays on unrelated renders; same rules, no work.
    rerender({ rules: [{ ...rule }] })
    await drain()
    expect(checkSpy).not.toHaveBeenCalled()

    rerender({ rules: [{ ...rule, check: { type: "target-forbids", targetPattern: "clean" } }] })
    await drain()
    expect(checkSpy).toHaveBeenCalledTimes(20)
    expect(result.current.infractions.size).toBe(0)
  })

  it("stops scanning when the page unmounts mid-scan", async () => {
    const cells = corpus(2000)
    const { unmount } = renderHook(() => useProjectInfractions(cells, [rule]))
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const beforeUnmount = checkSpy.mock.calls.length
    expect(beforeUnmount).toBeGreaterThan(0)
    expect(beforeUnmount).toBeLessThan(2000)

    unmount()
    await drain(20)
    expect(checkSpy).toHaveBeenCalledTimes(beforeUnmount)
  })

  it("settles even when the caller rebuilds the cells array every render", async () => {
    const cells = corpus(20)
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      // Same cells, new array identity — what a render-body `.flatMap()` does.
      return useProjectInfractions([...cells], [rule])
    })
    await drain(10)
    expect(result.current.infractions.size).toBe(20)
    expect(checkSpy).toHaveBeenCalledTimes(20)
    const settled = renders
    await drain(10)
    expect(renders).toBe(settled)
  })

  it("publishes an empty map with no rules enabled", async () => {
    const cells = corpus(10)
    const { result } = renderHook(() => useProjectInfractions(cells, []))
    await drain(5)
    expect(checkSpy).not.toHaveBeenCalled()
    expect(result.current.infractions.size).toBe(0)
    expect(result.current.scanning).toBe(false)
  })
})
