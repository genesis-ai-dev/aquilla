// AQU-1365 review: `isRefreshing` tells a reader that the rows on screen came
// from this device's cache and are still being brought up to date. The
// translation import's review waits for it: matched against a week-old cache,
// a teammate's filled lines look empty, get pre-ticked as fills, and are
// committed on stale parents the server then drops.

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
    readCellsCache: vi.fn(async () => null),
    scheduleCellsCacheWrite: vi.fn(),
    flushCellsCacheWrites: vi.fn(async () => undefined),
  }
})

import { fetchCellsDelta, streamFileCells } from "@/lib/sync/cells-read"
import { readCellsCache } from "@/lib/sync/cells-cache"
import { useActiveCellStore } from "./useActiveCellStore"

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

function renderStore() {
  return renderHook(() =>
    useActiveCellStore({ projectId: "p1", fileId: "f1", username: "alice", getToken: async () => "jwt", enabled: true }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useActiveCellStore — isRefreshing", () => {
  it("is true from a cache paint until the delta lands, while isLoading stays false", async () => {
    vi.mocked(readCellsCache).mockResolvedValue({
      rows: [row("c1", "source", "Source 1")],
      maxServerSeq: 10,
      projectEpoch: 1,
    } as never)
    let releaseDelta!: () => void
    vi.mocked(fetchCellsDelta).mockImplementation(() => new Promise((resolve) => {
      releaseDelta = () => resolve({
        kind: "delta",
        changedCellIds: ["c1"],
        cells: [row("c1", "source", "Source 1"), row("c1", "target", "Teammate's line")],
        maxServerSeq: 12,
      })
    }))
    const { result } = renderStore()
    await waitFor(() => expect(result.current.store.getCellView("c1")).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isRefreshing).toBe(true)
    expect(result.current.store.getCellView("c1")?.translated).toBe("")

    await act(async () => { releaseDelta() })
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.store.getCellView("c1")?.translated).toBe("Teammate's line")
  })

  it("is never set on a cold open, which reports isLoading instead", async () => {
    vi.mocked(readCellsCache).mockResolvedValue(null)
    vi.mocked(streamFileCells).mockImplementation(async (_p, _f, _jwt, onPage) => {
      await onPage([row("c1", "source", "Source 1")], true)
    })
    const seen: boolean[] = []
    const { result } = renderHook(() => {
      const value = useActiveCellStore({ projectId: "p1", fileId: "f1", username: "alice", getToken: async () => "jwt", enabled: true })
      seen.push(value.isRefreshing)
      return value
    })
    await waitFor(() => expect(result.current.store.getCellView("c1")).not.toBeNull())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(seen.every((value) => value === false)).toBe(true)
  })

  it("clears when bringing the cache up to date fails", async () => {
    vi.mocked(readCellsCache).mockResolvedValue({
      rows: [row("c1", "source", "Source 1")],
      maxServerSeq: 10,
      projectEpoch: 1,
    } as never)
    vi.mocked(fetchCellsDelta).mockRejectedValue(new Error("offline"))
    const { result } = renderStore()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.isRefreshing).toBe(false)
  })
})
