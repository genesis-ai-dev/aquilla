// AQU-464 — the takes strip's drift read.
//
// Composition coverage (AGENTS.md rule 12): the events here are the SERVER'S
// wire shape for GET …/cells/:id/history (newest-first, camel-cased,
// payloads exactly as `events-emit.ts` writes them), driven through the real
// resolver. A resolver test over hand-built fixtures plus a mocked hook would
// not catch the two halves disagreeing about that shape.

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

import { useRecordingTextDrift } from "./useRecordingTextDrift"
import { invalidateCellHistory } from "@/lib/sync/history-invalidation"

function event(over: Partial<CellHistoryEvent> & Pick<CellHistoryEvent, "id" | "serverSeq">): CellHistoryEvent {
  return {
    parentId: null,
    kind: "target.cell.commit",
    author: "alice",
    clientTs: 1700000000000,
    serverTs: 1700000000000 + over.serverSeq * 1000,
    payload: { value: "text" },
    ...over,
  }
}

// Newest first, as the route returns it: commit → attach → commit.
const SERVER_EVENTS: CellHistoryEvent[] = [
  event({ id: "c2", serverSeq: 3, parentId: "c1", payload: { value: "At the first" } }),
  event({
    id: "a1",
    serverSeq: 2,
    kind: "cell.audio.attach",
    payload: { audioId: "take-1", url: "frontier-audio://take-1.webm", slot: "recording" },
  }),
  event({ id: "c1", serverSeq: 1, payload: { value: "In the beginning" } }),
]

const getTokenForFile = vi.fn<(p: string, f: string) => Promise<string | null>>()

const base = {
  enabled: true,
  projectId: "p1",
  fileId: "f1",
  cellId: "c1",
  getTokenForFile,
}

beforeEach(() => {
  fetchCellHistoryMock.mockReset()
  getTokenForFile.mockReset()
  getTokenForFile.mockResolvedValue("token-x")
})

describe("useRecordingTextDrift", () => {
  it("resolves a take against the server's own history payload", async () => {
    fetchCellHistoryMock.mockResolvedValue(SERVER_EVENTS)

    const { result } = renderHook(() =>
      useRecordingTextDrift({ ...base, audioIds: ["take-1"] }),
    )

    await waitFor(() => expect(result.current.get("take-1")).toBeDefined())
    const drift = result.current.get("take-1")!
    expect(drift.textAtRecording).toBe("In the beginning")
    expect(drift.latestText).toBe("At the first")
    expect(drift.drifted).toBe(true)
  })

  it("reads history once for the whole strip, not once per take", async () => {
    fetchCellHistoryMock.mockResolvedValue(SERVER_EVENTS)

    renderHook(() => useRecordingTextDrift({ ...base, audioIds: ["take-1", "take-2", "take-3"] }))

    await waitFor(() => expect(fetchCellHistoryMock).toHaveBeenCalledTimes(1))
  })

  it("re-resolves when new text lands on the cell", async () => {
    fetchCellHistoryMock.mockResolvedValue([SERVER_EVENTS[1], SERVER_EVENTS[2]])
    const { result } = renderHook(() => useRecordingTextDrift({ ...base, audioIds: ["take-1"] }))

    await waitFor(() => expect(result.current.get("take-1")?.drifted).toBe(false))

    // A commit arrives — the take now speaks the old wording.
    fetchCellHistoryMock.mockResolvedValue(SERVER_EVENTS)
    act(() => invalidateCellHistory("p1", "f1", "c1"))

    await waitFor(() => expect(result.current.get("take-1")?.drifted).toBe(true))
  })

  it("does not read history when disabled or when the cell has no takes", async () => {
    fetchCellHistoryMock.mockResolvedValue(SERVER_EVENTS)

    const disabled = renderHook(() =>
      useRecordingTextDrift({ ...base, enabled: false, audioIds: ["take-1"] }),
    )
    const noTakes = renderHook(() => useRecordingTextDrift({ ...base, audioIds: [] }))

    await waitFor(() => expect(disabled.result.current.size).toBe(0))
    expect(noTakes.result.current.size).toBe(0)
    expect(fetchCellHistoryMock).not.toHaveBeenCalled()
  })

  it("stays empty rather than throwing when history is unreachable", async () => {
    // The badge is advisory; a strip that cannot reach history must still work.
    fetchCellHistoryMock.mockRejectedValue(new Error("HTTP 503"))

    const { result } = renderHook(() => useRecordingTextDrift({ ...base, audioIds: ["take-1"] }))

    await waitFor(() => expect(fetchCellHistoryMock).toHaveBeenCalled())
    expect(result.current.size).toBe(0)
  })

  it("stays empty when no sync token can be minted", async () => {
    getTokenForFile.mockResolvedValue(null)

    const { result } = renderHook(() => useRecordingTextDrift({ ...base, audioIds: ["take-1"] }))

    await waitFor(() => expect(getTokenForFile).toHaveBeenCalled())
    expect(fetchCellHistoryMock).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })
})
