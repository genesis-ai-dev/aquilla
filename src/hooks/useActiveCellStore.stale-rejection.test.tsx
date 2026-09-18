// Sync-head CAS invariants for the active cell store (I2/I3/I4).
//
// I2 — stale is a rejection. The server answers a POST /events with HTTP 200,
// lists a losing target.cell.commit under `accepted` AND under `stale[]`.
// Before this change the client treated "accepted" as "saved": the optimistic
// shadow stayed, `mergeProtectedRows` discarded every server row for the cell
// while the shadow lived, and the losing writer never saw the winner. These
// tests drive the REAL flush (real outbox record, real server body shape)
// through the tab-wide stale subscription into the store + revalidateCell.
//
// I3 — queue, don't drop. A revalidateCell / soft refetch requested while the
// same fetch is in flight must run again once it lands, not vanish.
//
// I4 — cache hygiene. Optimistic values must never be persisted as server
// rows, and a failed fetch must retry a bounded number of times.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellsDeltaResult } from "@/lib/sync/cells-read"
import type { CqrsRawEvent } from "@/lib/sync/outbox-types"
import { CQRS_SCHEMA_VERSION } from "@/lib/sync/outbox-types"

vi.mock("@/lib/sync/cells-read", () => ({
  streamFileCells: vi.fn(),
  fetchCellsByIds: vi.fn(),
  fetchCellsDelta: vi.fn(),
}))
vi.mock("@/lib/sync/cells-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cells-cache")>()
  return {
    ...actual,
    readCellsCache: vi.fn(async () => null),
    scheduleCellsCacheWrite: vi.fn(),
    flushCellsCacheWrites: vi.fn(async () => undefined),
  }
})

import { fetchCellsByIds, fetchCellsDelta, streamFileCells } from "@/lib/sync/cells-read"
import {
  flushCellsCacheWrites,
  scheduleCellsCacheWrite,
} from "@/lib/sync/cells-cache"
import { CellStore, useActiveCellStore } from "./useActiveCellStore"
import { flushOutboxBatch, subscribeStaleSiblings } from "@/lib/sync/outbox-flush"
import { enqueueOutboxEvent, resetOutboxConnectionForTests } from "@/lib/sync/outbox"

const streamMock = vi.mocked(streamFileCells)
const byIdsMock = vi.mocked(fetchCellsByIds)
const deltaMock = vi.mocked(fetchCellsDelta)
const writeCacheMock = vi.mocked(scheduleCellsCacheWrite)
const flushCacheMock = vi.mocked(flushCellsCacheWrites)

function row(cellId: string, side: "source" | "target", value: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    ...over,
  }
}

const FILE_ROWS = [row("c1", "source", "hello"), row("c1", "target", "hola", { eventId: "t-head-1" })]

/** Default stream: serves FILE_ROWS for either side. */
function serveStream(rows: CellRow[] = FILE_ROWS) {
  streamMock.mockImplementation(async (_p, _f, _jwt, onPage, side) => {
    await onPage(rows.filter((r) => r.side === side), true)
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function renderStore() {
  return renderHook(() =>
    useActiveCellStore({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      getToken: async () => "jwt",
      enabled: true,
    }),
  )
}

function renderSwitchableStore() {
  return renderHook(
    ({ fileId }: { fileId: string }) => useActiveCellStore({
      projectId: "p1",
      fileId,
      username: "alice",
      getToken: async () => "jwt",
      enabled: true,
    }),
    { initialProps: { fileId: "f1" } },
  )
}

async function resetIdb(): Promise<void> {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    d.onblocked = () => resolve()
    d.onsuccess = () => resolve()
    d.onerror = () => reject(d.error)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  serveStream()
  deltaMock.mockResolvedValue({ kind: "delta", changedCellIds: [], cells: [], maxServerSeq: 1 } satisfies CellsDeltaResult)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("CellStore.clearOptimisticForCell", () => {
  it("drops the shadow regardless of value so server rows stop being discarded (I2)", () => {
    const store = new CellStore()
    store.setRuntime({ projectId: "p1", fileId: "f1", username: "alice", requiredValidations: 1, auditStats: new Map() })
    store.replaceRows(FILE_ROWS, { full: true })
    store.applyOptimisticTargetEdit("c1", { value: "mine", eventId: "e-mine" })
    const winner = [row("c1", "target", "theirs", { eventId: "t-head-2" })]

    // Control: while the shadow lives the server row is discarded — the
    // value-equality clear (clearOptimisticIfValue) cannot free it.
    expect(store.clearOptimisticIfValue("c1", "theirs")).toBe(false)
    expect(store.mergeProtectedRows(winner, store.getWriteSeq()).discardedCellIds.has("c1")).toBe(true)

    expect(store.clearOptimisticForCell("c1")).toBe(true)
    expect(store.hasOptimisticEdits()).toBe(false)
    expect(store.mergeProtectedRows(winner, store.getWriteSeq()).discardedCellIds.size).toBe(0)
    // Idempotent.
    expect(store.clearOptimisticForCell("c1")).toBe(false)
  })
})

describe("I2: stale sibling → shadow cleared, winner lands on revalidate", () => {
  beforeEach(async () => { await resetIdb() })

  it("real flush stale[] entry drives clearOptimisticForCell + revalidateCell and the winner replaces the local text", async () => {
    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("hola"))

    // The user types; the row shows the local text and a commit is queued.
    act(() => result.current.applyOptimisticTargetEdit("c1", { value: "mine" }))
    expect(result.current.store.getCellView("c1")?.translated).toBe("mine")
    const event: CqrsRawEvent<"target.cell.commit"> = {
      id: "e-mine",
      schemaVersion: CQRS_SCHEMA_VERSION,
      kind: "target.cell.commit",
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      author: "alice",
      payload: { value: "mine", valueHtml: "<p>mine</p>" },
      clientTs: 1,
    }
    await enqueueOutboxEvent(event)

    // Server: another writer won; our commit is accepted-but-stale.
    const winner = row("c1", "target", "theirs", { eventId: "t-head-2" })
    byIdsMock.mockResolvedValue([FILE_ROWS[0], winner])

    // The ProjectWorkspace wiring, verbatim: stale → drop shadow → refetch cell.
    const seen: string[] = []
    const unsub = subscribeStaleSiblings((entries) => {
      for (const entry of entries) {
        if (!entry.cellId || entry.fileId !== "f1") continue
        seen.push(entry.id)
        result.current.store.clearOptimisticForCell(entry.cellId)
        result.current.revalidateCell(entry.cellId)
      }
    })
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        accepted: [{ id: "e-mine" }],
        rejected: [],
        stale: [{ id: "e-mine", fileId: "f1", cellId: "c1" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      const res = await flushOutboxBatch({
        getTokenForFile: async () => ({ token: "tok", status: 200 }),
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
      expect(res.accepted).toBe(1)
      expect(res.staleSiblingCount).toBe(1)
      expect(seen).toEqual(["e-mine"])
    } finally {
      unsub()
    }

    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("theirs"))
    // The next commit must chain on the real head, not the losing event.
    expect(result.current.store.getCellView("c1")?.targetEventId).toBe("t-head-2")
    expect(result.current.store.hasOptimisticEdits()).toBe(false)
  })
})

describe("I3: queue, don't drop", () => {
  it("revalidateCell requested while the cell GET is in flight re-runs once after it lands", async () => {
    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("hola"))

    const first = deferred<CellRow[]>()
    byIdsMock.mockReturnValueOnce(first.promise)
    byIdsMock.mockResolvedValueOnce([FILE_ROWS[0], row("c1", "target", "second", { eventId: "t-head-3" })])

    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(byIdsMock).toHaveBeenCalledTimes(1))
    // Second event.applied for the same cell while the first GET is pending.
    act(() => { result.current.revalidateCell("c1") })
    act(() => { result.current.revalidateCell("c1") })
    expect(byIdsMock).toHaveBeenCalledTimes(1)

    first.resolve([FILE_ROWS[0], row("c1", "target", "first", { eventId: "t-head-2" })])
    // Exactly one re-run (the two queued requests coalesce), and its result wins.
    await waitFor(() => expect(byIdsMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("second"))
    // No further runs.
    await new Promise((r) => setTimeout(r, 20))
    expect(byIdsMock).toHaveBeenCalledTimes(2)
  })

  it("a soft refetch requested during an in-flight fetch runs once after it completes", async () => {
    const gate = deferred<void>()
    let streams = 0
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage, side) => {
      streams++
      if (streams === 1) await gate.promise
      await onPage(FILE_ROWS.filter((r) => r.side === side), true)
    })
    const { result } = renderStore()
    // Both sides start together; the first (source) is parked on the gate.
    await waitFor(() => expect(streams).toBe(2))

    // Reconnect resync while the initial load is still streaming.
    act(() => result.current.revalidate())
    act(() => result.current.revalidate())
    expect(streams).toBe(2)

    gate.resolve()
    // Initial load = 2 stream calls (source + target). The stream mock reports
    // no cursor, so the queued soft pass is a full re-stream: exactly one more
    // pair (the two queued requests coalesce), then nothing.
    await waitFor(() => expect(streams).toBe(4))
    await new Promise((r) => setTimeout(r, 20))
    expect(streams).toBe(4)
    expect(deltaMock).not.toHaveBeenCalled()
  })
})

describe("I4: cache hygiene", () => {
  it("flushes the previous file on switch and all pending writes on page hide", async () => {
    const { result, rerender, unmount } = renderSwitchableStore()
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    flushCacheMock.mockClear()

    rerender({ fileId: "f2" })
    await waitFor(() => expect(flushCacheMock).toHaveBeenCalledWith("p1", "f1"))

    flushCacheMock.mockClear()
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(flushCacheMock).toHaveBeenCalledWith()
    unmount()
  })

  it("skips the cells-cache write while an optimistic shadow exists, and writes once it is gone", async () => {
    const { result } = renderStore()
    await waitFor(() => expect(writeCacheMock).toHaveBeenCalledTimes(1))
    // The initial (shadow-free) write persists only server rows.
    expect(writeCacheMock.mock.calls[0][2].find((r) => r.side === "target")?.value).toBe("hola")

    act(() => result.current.applyOptimisticTargetEdit("c1", { value: "mine" }))
    // Server row for the cell still carries the pre-edit text (the commit has
    // not projected yet) — exactly the state that used to be persisted with
    // the mutated value under the old eventId.
    byIdsMock.mockResolvedValue(FILE_ROWS)
    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(byIdsMock).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(writeCacheMock).toHaveBeenCalledTimes(1)
    expect(result.current.store.getCellView("c1")?.translated).toBe("mine")

    // The commit projects: server row equals the shadow → shadow confirmed →
    // the cache write resumes with server rows only.
    byIdsMock.mockResolvedValue([FILE_ROWS[0], row("c1", "target", "mine", { eventId: "t-head-2" })])
    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(writeCacheMock).toHaveBeenCalledTimes(2))
    expect(result.current.store.hasOptimisticEdits()).toBe(false)
    const persisted = writeCacheMock.mock.calls[1][2].find((r) => r.side === "target")
    expect(persisted).toMatchObject({ value: "mine", eventId: "t-head-2" })
  })

  it("retries a failed fetch at 2s/5s/10s and then stops (bounded)", async () => {
    vi.useFakeTimers()
    streamMock.mockRejectedValue(new Error("boom"))
    const { result } = renderStore()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // Each attempt is one stream PAIR (source + target start together).
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(result.current.isError).toBe(true)
    expect(result.current.isLoading).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
    expect(streamMock).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(streamMock).toHaveBeenCalledTimes(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(streamMock).toHaveBeenCalledTimes(6)
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(streamMock).toHaveBeenCalledTimes(8)
    // Budget exhausted: no fifth attempt, ever.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(streamMock).toHaveBeenCalledTimes(8)
    expect(result.current.isError).toBe(true)
  })

  it("a retry timer is cancelled by the generation fence (file switch)", async () => {
    vi.useFakeTimers()
    streamMock.mockRejectedValue(new Error("boom"))
    const { result, rerender } = renderHook(
      ({ fileId }: { fileId: string }) =>
        useActiveCellStore({ projectId: "p1", fileId, getToken: async () => "jwt", enabled: true }),
      { initialProps: { fileId: "f1" } },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // f1's failed load — one stream pair.
    expect(streamMock).toHaveBeenCalledTimes(2)
    serveStream()
    rerender({ fileId: "f2" })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // f2's own load — one stream pair.
    expect(streamMock).toHaveBeenCalledTimes(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    // The old f1 retry never fires.
    expect(streamMock).toHaveBeenCalledTimes(4)
    expect(result.current.isError).toBe(false)
  })
})
