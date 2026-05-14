// Phase 2b tests for useCellsAuditStats — drops React Query in favor of
// the Phase 2a pattern. Mocks the global fetch directly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useCellsAuditStats } from "./useCellsAuditStats"

vi.mock("@/lib/sync/sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.com",
}))

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

const TOKEN_FN = vi.fn().mockResolvedValue("test-token")

const STATS_RESPONSE = [
  {
    cellId: "cell-1",
    editCount: 3,
    contentHash: "abc123",
    lastEditAt: 1700,
    lastEditEventId: "ev-1",
    activeValidators: ["alice", "bob"],
  },
  {
    cellId: "cell-2",
    editCount: 7,
    contentHash: "def456",
    lastEditAt: 1800,
    lastEditEventId: null,
    activeValidators: [],
  },
]

describe("useCellsAuditStats (Phase 2b)", () => {
  it("returns a Map keyed by cellId on happy path", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 }),
    ) as unknown as typeof fetch

    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byCellId.size).toBe(2)
    const c1 = result.current.byCellId.get("cell-1")!
    expect(c1.editCount).toBe(3)
    expect(c1.activeValidators).toEqual(["alice", "bob"])
  })

  it("returns isError when token is null", async () => {
    const noTokenFn = vi.fn().mockResolvedValue(null)
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: noTokenFn,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("returns isError on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("err", { status: 500 }),
    ) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.byCellId.size).toBe(0)
  })

  it("does not fetch when disabled", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: false,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("does not fetch when fileId is null", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: null,
        getTokenForFile: TOKEN_FN,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("revalidate() triggers a refetch", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cells: [STATS_RESPONSE[0]] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 })) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.byCellId.size).toBe(2))
  })
})
