// Opening a file used to wait for its sync token before it would even look at
// the rows cached on this device, because the cache is keyed by the token's
// lane grants. Once a token for the project has been seen in this tab, the
// next file paints from the cache while its own token is still being minted.
// The token keeps the last word: grants that differ throw the early rows away.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
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

import { fetchCellsDelta } from "@/lib/sync/cells-read"
import { grantsVersionFromSyncToken, readCellsCache } from "@/lib/sync/cells-cache"
import { clearLastGrantsVersions, useActiveCellStore } from "./useActiveCellStore"

function row(cellId: string, value: string): CellRow {
  return {
    cellId, side: "source", value, valueHtml: null, type: null, canonicalRef: null,
    anchorCellId: null, eventId: `source-${cellId}`, sourceEventId: null, lastEditor: "alice",
    lastEditAt: 1, validated: false, wordCount: 1, endorsementCount: 0,
  }
}

/** An unsigned token whose payload carries the given lane grants. */
function tokenWithGrants(laneGrants: unknown[]): string {
  return `h.${btoa(JSON.stringify({ laneGrants }))}.s`
}
const GRANTS_A = tokenWithGrants([{ lane: "fr", level: 500 }])
const GRANTS_B = tokenWithGrants([{ lane: "fr", level: 300 }])

const cached = (cellId: string, value: string) =>
  ({ rows: [row(cellId, value)], maxServerSeq: 10, projectEpoch: 1 }) as never

function settledDelta() {
  vi.mocked(fetchCellsDelta).mockResolvedValue({ kind: "delta", changedCellIds: [], cells: [], maxServerSeq: 10 } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLastGrantsVersions()
})

describe("useActiveCellStore — cached rows ahead of the sync token", () => {
  it("waits for the token on the first file of a project: nothing says which snapshot is this user's", async () => {
    expect(grantsVersionFromSyncToken(GRANTS_A)).not.toBe(grantsVersionFromSyncToken(GRANTS_B))
    vi.mocked(readCellsCache).mockResolvedValue(cached("c1", "From cache"))
    let mint!: (token: string) => void
    const getToken = () => new Promise<string>((resolve) => { mint = resolve })
    const { result } = renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f1", username: "alice", getToken, enabled: true }),
    )
    await waitFor(() => expect(mint).toBeTypeOf("function"))
    expect(readCellsCache).not.toHaveBeenCalled()
    expect(result.current.isLoading).toBe(true)
    settledDelta()
    mint(GRANTS_A)
    await waitFor(() => expect(result.current.store.getCellView("c1")).not.toBeNull())
  })

  it("paints the next file from the cache while its token is still being minted", async () => {
    vi.mocked(readCellsCache).mockResolvedValue(cached("c1", "File one"))
    settledDelta()
    const first = renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f1", username: "alice", getToken: async () => GRANTS_A, enabled: true }),
    )
    await waitFor(() => expect(first.result.current.isRefreshing).toBe(false))
    await waitFor(() => expect(first.result.current.store.getCellView("c1")).not.toBeNull())
    first.unmount()

    vi.mocked(readCellsCache).mockClear()
    vi.mocked(readCellsCache).mockResolvedValue(cached("c2", "File two"))
    let mint!: (token: string) => void
    const getToken = () => new Promise<string>((resolve) => { mint = resolve })
    const second = renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f2", username: "alice", getToken, enabled: true }),
    )
    // Rows are up, and marked as still being brought up to date, with no token yet.
    await waitFor(() => expect(second.result.current.store.getCellView("c2")).not.toBeNull())
    expect(second.result.current.isLoading).toBe(false)
    expect(second.result.current.isRefreshing).toBe(true)
    expect(readCellsCache).toHaveBeenCalledWith("p1", "f2", grantsVersionFromSyncToken(GRANTS_A))

    mint(GRANTS_A)
    await waitFor(() => expect(second.result.current.isRefreshing).toBe(false))
    // Same grants: the early paint stands and the cache is not read twice.
    expect(readCellsCache).toHaveBeenCalledTimes(1)
    expect(second.result.current.store.getCellView("c2")).not.toBeNull()
  })

  it("throws the early rows away when the token carries different grants", async () => {
    vi.mocked(readCellsCache).mockResolvedValue(cached("c1", "File one"))
    settledDelta()
    const first = renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f1", username: "alice", getToken: async () => GRANTS_A, enabled: true }),
    )
    await waitFor(() => expect(first.result.current.isRefreshing).toBe(false))
    first.unmount()

    // Under the old grants this device cached a row; under the new ones, nothing.
    vi.mocked(readCellsCache).mockImplementation(async (_p, _f, grants) =>
      grants === grantsVersionFromSyncToken(GRANTS_A) ? cached("c-old", "Was visible") : null)
    let mint!: (token: string) => void
    const getToken = () => new Promise<string>((resolve) => { mint = resolve })
    vi.mocked(fetchCellsDelta).mockReset()
    const { streamFileCells } = await import("@/lib/sync/cells-read")
    vi.mocked(streamFileCells).mockImplementation(() => new Promise(() => {}) as never)
    const second = renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f2", username: "alice", getToken, enabled: true }),
    )
    await waitFor(() => expect(second.result.current.store.getCellView("c-old")).not.toBeNull())
    mint(GRANTS_B)
    await waitFor(() => expect(second.result.current.store.getCellView("c-old")).toBeNull())
    expect(second.result.current.isLoading).toBe(true)
  })

  it("does not carry one user's grants to another user of the same project", async () => {
    vi.mocked(readCellsCache).mockResolvedValue(cached("c1", "File one"))
    settledDelta()
    const first = renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f1", username: "alice", getToken: async () => GRANTS_A, enabled: true }),
    )
    await waitFor(() => expect(first.result.current.isRefreshing).toBe(false))
    first.unmount()

    vi.mocked(readCellsCache).mockClear()
    const getToken = () => new Promise<string>(() => {})
    renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f1", username: "bob", getToken, enabled: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readCellsCache).not.toHaveBeenCalled()
  })
})
