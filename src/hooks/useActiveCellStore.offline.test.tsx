// Phase 4 (corrected): useCells.ts's offline read branch was ported here
// because THIS hook — not useCells.ts — is the one ProjectWorkspace.tsx
// actually calls for the workspace cell list (see the AQU-538 comment at its
// call site). Mirrors useCells.test.tsx's "Tauri offline read branch" suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellsDeltaResult } from "@/lib/sync/cells-read"

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

const offlineTestState: { isTauri: boolean; ready: boolean; rows: CellRow[] } = {
  isTauri: false,
  ready: false,
  rows: [],
}
let offlineSubscribers: Array<() => void> = []

vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store: offlineTestState.isTauri ? ({} as object) : null, loading: false, error: null }),
}))

vi.mock("@/lib/offline/offline-reads", () => ({
  isProjectOfflineReady: () => offlineTestState.ready,
  resolveOfflineStore: (store: unknown) =>
    store && offlineTestState.isTauri && offlineTestState.ready ? store : null,
  readOfflineFileCells: (
    _store: unknown,
    _projectId: string,
    _fileId: string,
    opts?: { side?: "source" | "target" },
  ) => (opts?.side ? offlineTestState.rows.filter((r) => r.side === opts.side) : offlineTestState.rows),
  subscribeToOfflineFileCells: (_store: unknown, _projectId: string, _fileId: string, onChange: () => void) => {
    offlineSubscribers.push(onChange)
    return () => {
      offlineSubscribers = offlineSubscribers.filter((fn) => fn !== onChange)
    }
  },
}))

import { fetchCellsByIds, fetchCellsDelta, streamFileCells } from "@/lib/sync/cells-read"
import { useActiveCellStore } from "./useActiveCellStore"

const streamMock = vi.mocked(streamFileCells)
const byIdsMock = vi.mocked(fetchCellsByIds)
const deltaMock = vi.mocked(fetchCellsDelta)

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

function renderStore(projectId = "proj-offline", fileId = "file-offline") {
  return renderHook(() =>
    useActiveCellStore({
      projectId,
      fileId,
      username: "alice",
      getToken: async () => "jwt",
      enabled: true,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  offlineTestState.isTauri = false
  offlineTestState.ready = false
  offlineTestState.rows = []
  offlineSubscribers = []
  streamMock.mockImplementation(async () => {})
  deltaMock.mockResolvedValue({ kind: "delta", changedCellIds: [], cells: [], maxServerSeq: 1 } satisfies CellsDeltaResult)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useActiveCellStore (Tauri offline read branch)", () => {
  it("reads from LiveStore instead of HTTP when offline-ready", async () => {
    offlineTestState.isTauri = true
    offlineTestState.ready = true
    offlineTestState.rows = [
      row("c1", "source", "Source 1"),
      row("c1", "target", "Target 1", { validated: true }),
    ]

    const { result } = renderStore()

    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("Target 1"))
    expect(streamMock).not.toHaveBeenCalled()
    expect(deltaMock).not.toHaveBeenCalled()
    expect(byIdsMock).not.toHaveBeenCalled()
  })

  it("falls through to the unchanged HTTP path when Tauri but the project isn't offline-ready", async () => {
    offlineTestState.isTauri = true
    offlineTestState.ready = false
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage, side) => {
      const rows = [row("c1", "source", "src"), row("c1", "target", "tgt")].filter((r) => r.side === side)
      await onPage(rows, true)
    })

    const { result } = renderStore("proj-not-ready", "file-offline")

    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("tgt"))
    expect(streamMock).toHaveBeenCalled()
  })

  it("re-reads and updates cells when subscribeToOfflineFileCells fires, without any HTTP call", async () => {
    offlineTestState.isTauri = true
    offlineTestState.ready = true
    offlineTestState.rows = [row("c1", "source", "src"), row("c1", "target", "v1")]

    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("v1"))
    expect(offlineSubscribers.length).toBeGreaterThan(0)

    offlineTestState.rows = [row("c1", "source", "src"), row("c1", "target", "v2 (remote)")]
    act(() => {
      for (const fn of offlineSubscribers) fn()
    })

    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("v2 (remote)"))
    expect(streamMock).not.toHaveBeenCalled()
    expect(deltaMock).not.toHaveBeenCalled()
  })

  it("revalidateCell reads the one cellId from LiveStore synchronously, without fetchCellsByIds", async () => {
    offlineTestState.isTauri = true
    offlineTestState.ready = true
    offlineTestState.rows = [
      row("c1", "source", "src"),
      row("c1", "target", "old"),
      row("c2", "source", "src2"),
      row("c2", "target", "untouched"),
    ]

    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("old"))
    await waitFor(() => expect(result.current.store.getCellView("c2")?.translated).toBe("untouched"))

    offlineTestState.rows = offlineTestState.rows.map((r) =>
      r.cellId === "c1" && r.side === "target" ? { ...r, value: "new" } : r,
    )
    act(() => { result.current.revalidateCell("c1") })

    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("new"))
    expect(result.current.store.getCellView("c2")?.translated).toBe("untouched")
    expect(byIdsMock).not.toHaveBeenCalled()
  })

  it("keeps an in-flight optimistic edit visible when the offline branch re-reads a stale (pre-flush) snapshot", async () => {
    offlineTestState.isTauri = true
    offlineTestState.ready = true
    offlineTestState.rows = [row("c1", "source", "src"), row("c1", "target", "old")]

    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getCellView("c1")?.translated).toBe("old"))

    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "predicted" }) })
    expect(result.current.store.getCellView("c1")?.translated).toBe("predicted")

    act(() => {
      for (const fn of offlineSubscribers) fn()
    })

    expect(result.current.store.getCellView("c1")?.translated).toBe("predicted")
  })
})
