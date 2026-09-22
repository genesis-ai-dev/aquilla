// AQU-1326: file-open paint order for the store the workspace actually reads.
//
// This is the regression's escape level. The same target-first-then-source
// ordering existed in BOTH `useCells` and `useActiveCellStore`; a fix and unit
// test on `useCells` alone left the workspace path untouched, because
// `ProjectWorkspace` mounts `useActiveCellStore`. These tests pin the ordering
// on the hook the editor really uses.
//
// AQU-1328: first paint must contain whole rows, including existing targets.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/lib/sync/cells-read", () => ({
  streamFileCells: vi.fn(),
  fetchCellsByIds: vi.fn(),
  fetchCellsDelta: vi.fn(),
}))
vi.mock("@/lib/sync/cells-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cells-cache")>()
  return {
    ...actual,
    // No warm cache: every test here exercises the cold full-stream path.
    readCellsCache: vi.fn(async () => null),
    scheduleCellsCacheWrite: vi.fn(),
    flushCellsCacheWrites: vi.fn(async () => undefined),
  }
})

import { streamFileCells } from "@/lib/sync/cells-read"
import { useActiveCellStore } from "./useActiveCellStore"

const streamMock = vi.mocked(streamFileCells)

function row(cellId: string, side: "source" | "target", value: string): CellRow {
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
  }
}

const SOURCE_ROWS = [row("c1", "source", "Source 1"), row("c2", "source", "Source 2")]
const TARGET_ROWS = [row("c1", "target", "Translated 1"), row("c2", "target", "Translated 2")]

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useActiveCellStore — complete-row paint (AQU-1328)", () => {
  it("requests a single paired stream containing every target lane", async () => {
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage) => {
      await onPage([...SOURCE_ROWS, ...TARGET_ROWS], true)
    })
    const { result } = renderStore()
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(streamMock).toHaveBeenCalledOnce()
    expect(streamMock.mock.calls[0].slice(4)).toEqual([undefined, expect.any(Function), undefined, true])
    expect(result.current.store.getCellView("c1")?.translated).toBe("Translated 1")
  })

  it("reveals complete rows before the tail and preserves edits made during loading", async () => {
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => { releaseTail = resolve })
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage) => {
      await onPage([SOURCE_ROWS[0], TARGET_ROWS[0], row("empty", "source", "Untranslated")], false)
      await tail
      await onPage([SOURCE_ROWS[1], TARGET_ROWS[1]], true)
    })
    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getAllSummaries()).toHaveLength(2))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.store.getCellView("c1")?.translated).toBe("Translated 1")
    expect(result.current.store.getCellView("empty")?.translated).toBe("")
    expect(result.current.store.getCellView("c2")).toBeNull()
    act(() => result.current.applyOptimisticTargetEdit("c1", { value: "My correction" }))
    await act(async () => { releaseTail() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.store.getCellView("c1")?.translated).toBe("My correction")
    expect(result.current.store.getCellView("c2")?.translated).toBe("Translated 2")
  })

  it("publishes a coalesced page even when the following page is still pending", async () => {
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => { releaseTail = resolve })
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage) => {
      await onPage([SOURCE_ROWS[0], TARGET_ROWS[0]], false)
      await onPage([SOURCE_ROWS[1], TARGET_ROWS[1]], false)
      await tail
      await onPage([row("c3", "source", "Last")], true)
    })
    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getCellView("c2")?.translated).toBe("Translated 2"))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.store.getCellView("c3")).toBeNull()
    await act(async () => { releaseTail() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })

  it("retains complete rows and exposes an error when the tail fails", async () => {
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage) => {
      await onPage([SOURCE_ROWS[0], TARGET_ROWS[0]], false)
      throw new Error("Tail failed")
    })
    const { result } = renderStore()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.store.getCellView("c1")?.translated).toBe("Translated 1")
    expect(result.current.store.getCellView("c2")).toBeNull()
  })

  it("still paints target-only rows", async () => {
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage) => {
      await onPage(TARGET_ROWS, true)
    })
    const { result } = renderStore()
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.store.getAllSummaries()).toHaveLength(2)
  })
})
