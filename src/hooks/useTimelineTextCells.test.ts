import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import { useTimelineTextCells } from "./useTimelineTextCells"

vi.mock("@/lib/sync/cells-read", () => ({ fetchAllFileCells: vi.fn() }))
const row = (id: string, value: string): CellRow => ({
  cellId: id, side: "source", value, valueHtml: null, type: "cue",
  canonicalRef: null, anchorCellId: null, eventId: `event-${id}`,
  sourceEventId: null, lastEditor: "alice", lastEditAt: 1,
  validated: false, wordCount: 2, startMs: 2000, endMs: 5000,
})
const getToken = vi.fn(async () => "token")
beforeEach(() => { vi.mocked(fetchAllFileCells).mockReset(); getToken.mockClear() })

describe("independent timeline text reads", () => {
  it("loads each referenced file once and keeps its own wording and timing", async () => {
    vi.mocked(fetchAllFileCells).mockImplementation(async (_project, fileId) => [row(fileId, fileId)])
    const { result } = renderHook(() => useTimelineTextCells({
      projectId: "p", fileIds: ["a", "a", "b"], getToken,
    }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(fetchAllFileCells).toHaveBeenCalledTimes(2)
    expect(result.current.cellsByFile.a[0])
      .toMatchObject({ id: "a", fileId: "a", original: "a", startTime: 2, endTime: 5 })
    expect(result.current.cellsByFile.b[0].original).toBe("b")
  })

  it("ignores an old file's late result after switching tracks", async () => {
    let finishOld!: (rows: CellRow[]) => void
    vi.mocked(fetchAllFileCells).mockImplementation(async (_project, fileId) => {
      if (fileId === "old") return new Promise(resolve => { finishOld = resolve })
      return [row("new", "New wording")]
    })
    const { result, rerender } = renderHook(({ fileIds }) => useTimelineTextCells({
      projectId: "p", fileIds, getToken,
    }), { initialProps: { fileIds: ["old"] } })
    await waitFor(() => expect(fetchAllFileCells).toHaveBeenCalledTimes(1))
    rerender({ fileIds: ["new"] })
    await waitFor(() => expect(result.current.cellsByFile.new?.[0].original).toBe("New wording"))
    await act(async () => { finishOld([row("old", "Old wording")]) })
    expect(result.current.cellsByFile.old).toBeUndefined()
  })

  it("surfaces a failed read instead of inventing empty captions", async () => {
    vi.mocked(fetchAllFileCells).mockRejectedValue(new Error("Cannot read captions"))
    const { result } = renderHook(() => useTimelineTextCells({
      projectId: "p", fileIds: ["a"], getToken,
    }))
    await waitFor(() => expect(result.current.errors.a?.message).toBe("Cannot read captions"))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.cellsByFile.a).toEqual([])
  })

  it("does not fetch while the media timeline is closed", () => {
    const { result } = renderHook(() => useTimelineTextCells({
      projectId: "p", fileIds: ["a"], getToken, enabled: false,
    }))
    expect(fetchAllFileCells).not.toHaveBeenCalled()
    expect(result.current.cellsByFile).toEqual({})
  })

  it("refreshes known caption files after writes and ignores unrelated files", async () => {
    vi.mocked(fetchAllFileCells).mockResolvedValue([row("a", "Before")])
    const { result } = renderHook(() => useTimelineTextCells({
      projectId: "p", fileIds: ["a"], getToken,
    }))
    await waitFor(() => expect(result.current.cellsByFile.a?.[0].original).toBe("Before"))
    act(() => result.current.refresh("unrelated"))
    expect(fetchAllFileCells).toHaveBeenCalledTimes(1)
    vi.mocked(fetchAllFileCells).mockResolvedValue([row("a", "After")])
    act(() => result.current.refresh("a"))
    await waitFor(() => expect(result.current.cellsByFile.a?.[0].original).toBe("After"))
  })
})
