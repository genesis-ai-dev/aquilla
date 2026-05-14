// Phase 2b tests for the read-side useCellHistory hook. Mocks the
// `fetchCellHistory` wrapper directly so the hook surface is tested
// without touching the network.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
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

import { useCellHistory } from "./useCellHistory"

function makeEvent(
  over: Partial<CellHistoryEvent> & Pick<CellHistoryEvent, "id" | "serverSeq">,
): CellHistoryEvent {
  return {
    parentId: null,
    kind: "target.cell.commit",
    author: "alice",
    clientTs: 0,
    serverTs: over.serverSeq * 1000,
    payload: {},
    ...over,
  }
}

const getToken = vi.fn().mockResolvedValue("token-x")

beforeEach(() => {
  fetchCellHistoryMock.mockReset()
  getToken.mockClear()
  getToken.mockResolvedValue("token-x")
})

describe("useCellHistory (Phase 2b)", () => {
  it("fetches on mount and returns events", async () => {
    fetchCellHistoryMock.mockResolvedValueOnce([
      makeEvent({ id: "e1", serverSeq: 1 }),
      makeEvent({ id: "e2", serverSeq: 2 }),
    ])
    const { result } = renderHook(() =>
      useCellHistory({
        projectId: "proj-a",
        fileId: "file-x",
        cellId: "cell-1",
        getToken,
      }),
    )
    await waitFor(() => expect(result.current.events).toHaveLength(2))
    expect(result.current.isError).toBe(false)
    expect(result.current.events.map((e) => e.id)).toEqual(["e1", "e2"])
  })

  it("isError when getToken returns null", async () => {
    getToken.mockResolvedValueOnce(null)
    const { result } = renderHook(() =>
      useCellHistory({
        projectId: "proj-a",
        fileId: "file-x",
        cellId: "cell-1",
        getToken,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.events).toEqual([])
    expect(fetchCellHistoryMock).not.toHaveBeenCalled()
  })

  it("does not fetch when disabled / nulls", async () => {
    const { result } = renderHook(() =>
      useCellHistory({
        projectId: null,
        fileId: "file-x",
        cellId: "cell-1",
        getToken,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.events).toEqual([])
    expect(fetchCellHistoryMock).not.toHaveBeenCalled()
  })

  it("revalidate triggers a refetch", async () => {
    fetchCellHistoryMock.mockResolvedValueOnce([makeEvent({ id: "v1", serverSeq: 1 })])
    const { result } = renderHook(() =>
      useCellHistory({
        projectId: "proj-a",
        fileId: "file-x",
        cellId: "cell-1",
        getToken,
      }),
    )
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    fetchCellHistoryMock.mockResolvedValueOnce([
      makeEvent({ id: "v1", serverSeq: 1 }),
      makeEvent({ id: "v2", serverSeq: 2 }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.events).toHaveLength(2))
  })
})
