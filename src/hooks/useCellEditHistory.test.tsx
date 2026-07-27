// Phase 2b tests for useCellEditHistory. Uses the same mock-the-wrapper
// pattern as useCells.test.tsx — no React Query, no global fetch mocking.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act, fireEvent } from "@testing-library/react"
import type { CellHistoryEvent } from "@/lib/sync/history-read-types"

const fetchCellHistoryMock = vi.fn<
  (
    projectId: string,
    fileId: string,
    cellId: string,
    jwt: string,
    opts?: { limit?: number },
  ) => Promise<CellHistoryEvent[]>
>()

vi.mock("@/lib/sync/history-read", () => ({
  fetchCellHistory: (...args: unknown[]) =>
    fetchCellHistoryMock(...(args as Parameters<typeof fetchCellHistoryMock>)),
}))

import { useCellEditHistory } from "./useCellEditHistory"
import { invalidateCellHistory } from "@/lib/sync/history-invalidation"

function makeEvent(
  over: Partial<CellHistoryEvent> & Pick<CellHistoryEvent, "id" | "serverSeq">,
): CellHistoryEvent {
  return {
    parentId: null,
    kind: "target.cell.commit",
    author: "alice",
    clientTs: 1700000000000,
    serverTs: 1700000000000 + over.serverSeq * 1000,
    payload: { value: "ed" },
    ...over,
  }
}

const SERVER_EVENTS: CellHistoryEvent[] = [
  // newest first — matches server output
  makeEvent({ id: "e3", serverSeq: 3, payload: { value: "third edit" } }),
  makeEvent({ id: "e2", serverSeq: 2, payload: { value: "second edit" }, author: "bob" }),
  makeEvent({ id: "e1", serverSeq: 1, payload: { value: "first edit" } }),
]

const getTokenForFile = vi.fn().mockResolvedValue("token-x")

beforeEach(() => {
  fetchCellHistoryMock.mockReset()
  getTokenForFile.mockClear()
  getTokenForFile.mockResolvedValue("token-x")
})

describe("useCellEditHistory (Phase 2b)", () => {
  it("returns history entries oldest-first (reversed from server)", async () => {
    fetchCellHistoryMock.mockResolvedValueOnce(SERVER_EVENTS)
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: true,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile,
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.history.map((e) => e.value)).toEqual([
      "first edit",
      "second edit",
      "third edit",
    ])
  })

  it("maps the newest-first server payload to CellHistoryEntry shape", async () => {
    fetchCellHistoryMock.mockResolvedValueOnce([
      makeEvent({
        id: "e3",
        serverSeq: 3,
        payload: {
          value: "third edit",
          valueHtml: '<p data-idml-version="2">third edit</p>',
        },
      }),
    ])
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: true,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile,
      }),
    )
    await waitFor(() => expect(result.current.history).toHaveLength(1))
    const entry = result.current.history[0]
    expect(entry.value).toBe("third edit")
    expect(entry.valueHtml).toBe('<p data-idml-version="2">third edit</p>')
    expect(entry.source).toBe("human")
    expect(entry.author).toBe("alice")
    expect(entry.validated).toBe(false)
  })

  it("filters out events that aren't *.cell.commit", async () => {
    fetchCellHistoryMock.mockResolvedValueOnce([
      makeEvent({ id: "v", serverSeq: 9, kind: "cell.validate", payload: {} }),
      ...SERVER_EVENTS,
      makeEvent({ id: "u", serverSeq: 0, kind: "cell.unvalidate", payload: {} }),
    ])
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: true,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile,
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.history).toHaveLength(3)
  })

  it("surfaces isError + empty history when getTokenForFile returns null", async () => {
    getTokenForFile.mockResolvedValueOnce(null)
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: true,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.history).toEqual([])
    expect(fetchCellHistoryMock).not.toHaveBeenCalled()
  })

  it("surfaces isError when the fetch wrapper throws", async () => {
    fetchCellHistoryMock.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: true,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.history).toEqual([])
  })

  it("does not fetch when disabled", async () => {
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: false,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.history).toEqual([])
    expect(fetchCellHistoryMock).not.toHaveBeenCalled()
  })

  it("does not fetch when cellId is null", async () => {
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: true,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: null,
        getTokenForFile,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.history).toEqual([])
    expect(fetchCellHistoryMock).not.toHaveBeenCalled()
  })

  it("revalidate() triggers a refetch and reflects new data", async () => {
    fetchCellHistoryMock.mockResolvedValueOnce([
      makeEvent({ id: "v1", serverSeq: 1, payload: { value: "old" } }),
    ])
    const { result } = renderHook(() =>
      useCellEditHistory({
        enabled: true,
        projectId: "proj-a",
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile,
      }),
    )
    await waitFor(() => expect(result.current.history).toHaveLength(1))
    expect(result.current.history[0].value).toBe("old")

    fetchCellHistoryMock.mockResolvedValueOnce([
      makeEvent({ id: "v2", serverSeq: 2, payload: { value: "new" } }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.history[0].value).toBe("new"))
    expect(fetchCellHistoryMock).toHaveBeenCalledTimes(2)
  })

  it("does not refetch just because the browser regains focus", async () => {
    fetchCellHistoryMock.mockResolvedValue(SERVER_EVENTS)
    renderHook(() => useCellEditHistory({
      enabled: true,
      projectId: "proj-a",
      fileId: "file-abc",
      cellId: "cell-1",
      getTokenForFile,
    }))
    await waitFor(() => expect(fetchCellHistoryMock).toHaveBeenCalledTimes(1))
    fireEvent.focus(window)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fetchCellHistoryMock).toHaveBeenCalledTimes(1)
  })

  it("refetches only after an exact cell history invalidation", async () => {
    fetchCellHistoryMock.mockResolvedValue(SERVER_EVENTS)
    renderHook(() => useCellEditHistory({
      enabled: true,
      projectId: "proj-a",
      fileId: "file-abc",
      cellId: "cell-1",
      getTokenForFile,
    }))
    await waitFor(() => expect(fetchCellHistoryMock).toHaveBeenCalledTimes(1))

    act(() => invalidateCellHistory("proj-a", "file-abc", "other-cell"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fetchCellHistoryMock).toHaveBeenCalledTimes(1)

    act(() => invalidateCellHistory("proj-a", "file-abc", "cell-1"))
    await waitFor(() => expect(fetchCellHistoryMock).toHaveBeenCalledTimes(2))
  })
})
