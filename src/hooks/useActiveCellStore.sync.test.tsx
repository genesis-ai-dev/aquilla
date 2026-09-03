import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useActiveCellStore } from "./useActiveCellStore"
import { fetchCellsDelta, streamFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/lib/sync/cells-read", () => ({ streamFileCells: vi.fn(), fetchCellsDelta: vi.fn(), fetchCellsByIds: vi.fn() }))
vi.mock("@/lib/sync/outbox", () => ({ peekOutboxBatch: async () => [], subscribeToOutbox: () => () => {} }))
vi.mock("@/lib/sync/cells-cache", async (original) => ({
  ...await original<typeof import("@/lib/sync/cells-cache")>(),
  readCellsCache: async () => null,
  writeCellsCache: vi.fn(async () => {}),
}))
afterEach(() => vi.resetAllMocks())

function row(side: "source" | "target", value: string): CellRow {
  return { cellId: "c", side, value, eventId: value, valueHtml: null, type: "text", canonicalRef: null,
    anchorCellId: null, sourceEventId: null, lastEditor: null, lastEditAt: 0, validated: false, wordCount: 1 }
}

describe("editor keyset hydration", () => {
  it("automatically catches up from the first safe watermark without another full stream", async () => {
    vi.mocked(streamFileCells).mockImplementation(async (_p, _f, _t, onPage, side, onMeta) => {
      onMeta?.({ maxServerSeq: side === "target" ? 10 : 20, projectEpoch: 1, pagination: "keyset" })
      await onPage([row(side!, side === "target" ? "old translation" : "source")], true)
    })
    vi.mocked(fetchCellsDelta).mockResolvedValue({ kind: "delta", changedCellIds: ["c"], cells: [row("source", "source"), row("target", "new translation")], maxServerSeq: 21, projectEpoch: 1 })
    const { result } = renderHook(() => useActiveCellStore({ projectId: "p", fileId: "f", getToken: async () => "token" }))
    await waitFor(() => expect(result.current.store.getMaxServerSeq()).toBe(21))
    expect(fetchCellsDelta).toHaveBeenCalledExactlyOnceWith("p", "f", 10, "token", undefined, 1, expect.any(AbortSignal))
    expect(streamFileCells).toHaveBeenCalledTimes(2)
    expect(result.current.store.toRows().find((r) => r.side === "target")?.value).toBe("new translation")
  })

  it("aborts a superseded file's in-flight scan instead of downloading its remaining pages", async () => {
    const signals: AbortSignal[] = []
    vi.mocked(streamFileCells).mockImplementation(async (_p, _f, _t, _onPage, _side, _meta, _lane, scan) => {
      signals.push(scan!.signal!)
      await new Promise<void>((resolve) => scan!.signal!.addEventListener("abort", () => resolve(), { once: true }))
    })
    const { rerender, unmount } = renderHook(({ fileId }) => useActiveCellStore({ projectId: "p", fileId, getToken: async () => "token" }), { initialProps: { fileId: "f" } })
    await waitFor(() => expect(signals).toHaveLength(1))
    act(() => rerender({ fileId: "other" }))
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0].aborted).toBe(true)
    unmount()
    expect(signals[1].aborted).toBe(true)
  })
})
