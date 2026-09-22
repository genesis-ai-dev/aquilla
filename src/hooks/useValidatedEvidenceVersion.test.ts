import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useValidatedEvidenceVersion } from "./useValidatedEvidenceVersion"
import type { CellSummary } from "./useActiveCellStore"

type Evidence = Pick<CellSummary, "id" | "status" | "translated" | "targetEventId" | "lastEditAt">
const row = (id: string, over: Partial<Evidence> = {}): Evidence => ({
  id, status: "validated", translated: "translation", targetEventId: `head-${id}`, ...over,
})

it("does not inspect cells while the queue is unavailable", () => {
  const cells = [row("a")]
  const readStatus = vi.fn(() => "validated")
  Object.defineProperty(cells[0], "status", { get: readStatus })
  const { result, rerender } = renderHook(({ available }) => useValidatedEvidenceVersion(available, cells), {
    initialProps: { available: false },
  })
  expect(result.current).toBe("")
  expect(readStatus).not.toHaveBeenCalled()
  rerender({ available: true })
  expect(result.current).toBe("a:head-a")
  expect(readStatus).toHaveBeenCalledTimes(1)
  rerender({ available: true })
  expect(readStatus).toHaveBeenCalledTimes(1)
})

describe("current validation evidence", () => {
  it("refreshes on validated heads and removals, preserving timestamp fallback and order", () => {
    const cells = [row("a"), row("b", { targetEventId: undefined, lastEditAt: 42 }),
      row("empty", { translated: "  " }), row("draft", { status: "unvalidated" })]
    const { result, rerender } = renderHook(({ available, cells }) => useValidatedEvidenceVersion(available, cells), {
      initialProps: { available: true, cells },
    })
    expect(result.current).toBe("a:head-a|b:42")
    rerender({ available: true, cells: [row("a", { targetEventId: "new-head" }), cells[1]] })
    expect(result.current).toBe("a:new-head|b:42")
    rerender({ available: false, cells: [row("lane-b")] })
    expect(result.current).toBe("")
    rerender({ available: true, cells: [row("lane-b")] })
    expect(result.current).toBe("lane-b:head-lane-b")
    rerender({ available: true, cells: [] })
    expect(result.current).toBe("")
  })
})
