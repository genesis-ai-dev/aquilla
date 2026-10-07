import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCellMorph } from "./useCellMorph"
import type { MorphWord } from "@/lib/sync/morph-read"

const fetchCellMorph = vi.hoisted(() => vi.fn())
vi.mock("@/lib/sync/morph-read", () => ({ fetchCellMorph }))

// AQU-462. What matters here is WHEN this fires: a Macula book is tens of
// thousands of morph rows, so the read belongs to the row whose alignment view
// is open — not to every rendered row, and never to a whole file.

const WORDS: MorphWord[] = [{ cellId: "c1", wordSeq: 1, surface: "λογος", lemma: "λογος" }]

const base = {
  projectId: "p1",
  fileId: "f1",
  cellId: "c1",
  getTokenForFile: async () => "tok",
}

beforeEach(() => {
  fetchCellMorph.mockResolvedValue(WORDS)
})

afterEach(() => {
  fetchCellMorph.mockReset()
})

describe("useCellMorph", () => {
  it("does not read while disabled", async () => {
    const { result } = renderHook(() => useCellMorph({ ...base, enabled: false }))
    await act(async () => { await Promise.resolve() })

    expect(fetchCellMorph).not.toHaveBeenCalled()
    expect(result.current.words).toEqual([])
  })

  it("reads exactly the open cell once enabled", async () => {
    const { result } = renderHook(() => useCellMorph({ ...base, enabled: true }))
    await act(async () => { await Promise.resolve() })

    expect(fetchCellMorph).toHaveBeenCalledTimes(1)
    expect(fetchCellMorph.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      fileId: "f1",
      cellIds: ["c1"],
      jwt: "tok",
    })
    expect(result.current.words).toEqual(WORDS)
  })

  it("drops the previous cell's words when the view closes", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useCellMorph({ ...base, enabled }),
      { initialProps: { enabled: true } },
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.words).toEqual(WORDS)

    rerender({ enabled: false })
    await act(async () => { await Promise.resolve() })

    // Stale words must not survive into the next thing the panel shows.
    expect(result.current.words).toEqual([])
  })

  it("reports a failed read without throwing at the row", async () => {
    fetchCellMorph.mockRejectedValueOnce(new Error("HTTP 500"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const { result } = renderHook(() => useCellMorph({ ...base, enabled: true }))
    await act(async () => { await Promise.resolve() })

    expect(result.current.isError).toBe(true)
    expect(result.current.words).toEqual([])
    warn.mockRestore()
  })

  it("treats a missing token as an error rather than an empty verse", async () => {
    const { result } = renderHook(() =>
      useCellMorph({ ...base, enabled: true, getTokenForFile: async () => null }),
    )
    await act(async () => { await Promise.resolve() })

    expect(fetchCellMorph).not.toHaveBeenCalled()
    expect(result.current.isError).toBe(true)
  })
})
