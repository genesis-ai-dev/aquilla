// A refresh must never blank the drawer.
//
// WHY: `doFetch` seeds `history` from the IndexedDB outbox before awaiting the
// server read, so the user can see locally durable commits offline. On the
// FIRST load that is correct. On a REFRESH (outbox write, or an `event.applied`
// invalidation frame) the outbox is usually empty — every already-flushed
// commit lives only on the server — so seeding it wiped the loaded history for
// the duration of the round trip. The drawer flashed "No edits yet.", unmounted
// its entry list, and remounted it with fresh local state, silently collapsing
// an expanded "Show intermediate edits" group under the user's cursor.
// That flash is what made editor/history-drawer-intermediate-edits.smoke fail
// under load.

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

import { useCellEditHistory } from "./useCellEditHistory"
import { invalidateCellHistory } from "@/lib/sync/history-invalidation"

function makeEvent(id: string, seq: number, value: string): CellHistoryEvent {
  return {
    id,
    serverSeq: seq,
    parentId: null,
    kind: "target.cell.commit",
    author: "alice",
    clientTs: 1700000000000,
    serverTs: 1700000000000 + seq * 1000,
    payload: { value },
  }
}

const SERVER_EVENTS = [
  makeEvent("e3", 3, "v1 final"),
  makeEvent("e2", 2, "v1 updated"),
  makeEvent("e1", 1, "v1"),
]

const getTokenForFile = vi.fn().mockResolvedValue("token-x")

const OPTS = {
  enabled: true,
  projectId: "proj-a",
  fileId: "file-abc",
  cellId: "cell-1",
  getTokenForFile,
}

beforeEach(() => {
  fetchCellHistoryMock.mockReset()
  getTokenForFile.mockClear()
  getTokenForFile.mockResolvedValue("token-x")
})

describe("useCellEditHistory refresh stability", () => {
  it("keeps loaded history rendered while an invalidation refetch is in flight", async () => {
    fetchCellHistoryMock.mockResolvedValueOnce(SERVER_EVENTS)
    const seen: number[] = []
    const { result } = renderHook(() => {
      const r = useCellEditHistory(OPTS)
      seen.push(r.history.length)
      return r
    })
    await waitFor(() => expect(result.current.history).toHaveLength(3))

    // Only renders from here on matter: the list is loaded and on screen.
    seen.length = 0
    let release: (events: CellHistoryEvent[]) => void = () => {}
    fetchCellHistoryMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve }),
    )
    act(() => invalidateCellHistory("proj-a", "file-abc", "cell-1"))
    await waitFor(() => expect(fetchCellHistoryMock).toHaveBeenCalledTimes(2))

    // The in-flight refresh must not have emptied the list at any point.
    expect(seen).not.toContain(0)
    expect(result.current.history).toHaveLength(3)

    await act(async () => { release(SERVER_EVENTS) })
    expect(result.current.history.map((e) => e.value)).toEqual([
      "v1",
      "v1 updated",
      "v1 final",
    ])
  })
})
