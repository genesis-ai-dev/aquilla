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

  // Perf regression guard (see ProjectWorkspace.tsx commitCompletedCell etc.):
  // a single-cell commit must not re-fetch stats for the whole file. Without
  // revalidateCellStats, every keystroke-commit paired an O(1) cell fetch
  // with an O(all-cells) audit-stats fetch.
  describe("revalidateCellStats", () => {
    it("fetches only the given cell (scoped by cellId) and merges it into the existing map, without a full-file refetch", async () => {
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
      await waitFor(() => expect(result.current.byCellId.size).toBe(2))
      expect(global.fetch).toHaveBeenCalledTimes(1)

      const updatedCell1 = {
        cellId: "cell-1",
        editCount: 4,
        contentHash: "post-commit-hash",
        lastEditAt: 1900,
        lastEditEventId: "ev-2",
        activeValidators: [],
      }
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ cells: [updatedCell1] }), { status: 200 }),
      ) as unknown as typeof fetch

      act(() => { result.current.revalidateCellStats("cell-1") })

      await waitFor(() => expect(result.current.byCellId.get("cell-1")?.editCount).toBe(4))

      // Exactly one request, scoped to the changed cell — not a full-file fetch.
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(calledUrl).toContain("cellId=cell-1")

      // The untouched cell's stats are preserved (merge, not replace).
      expect(result.current.byCellId.get("cell-2")?.editCount).toBe(7)
      expect(result.current.byCellId.size).toBe(2)
    })

    it("prefers target-side stats when a scoped response includes both source and target rows", async () => {
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
      await waitFor(() => expect(result.current.byCellId.size).toBe(2))

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({
          cells: [
            {
              side: "source",
              cellId: "cell-1",
              editCount: 1,
              contentHash: "source-hash",
              lastEditAt: 1000,
              lastEditEventId: "source-event",
              activeValidators: [],
            },
            {
              side: "target",
              cellId: "cell-1",
              editCount: 4,
              contentHash: "target-hash",
              lastEditAt: 1900,
              lastEditEventId: "target-event",
              activeValidators: ["bob"],
            },
          ],
        }), { status: 200 }),
      ) as unknown as typeof fetch

      act(() => { result.current.revalidateCellStats("cell-1") })

      await waitFor(() => expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["bob"]))
      expect(result.current.byCellId.get("cell-1")?.lastEditEventId).toBe("target-event")
    })

    it("is a no-op when the server returns no matching row (e.g. a stale cellId)", async () => {
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
      await waitFor(() => expect(result.current.byCellId.size).toBe(2))

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ cells: [] }), { status: 200 }),
      ) as unknown as typeof fetch
      await act(async () => {
        result.current.revalidateCellStats("cell-1")
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.byCellId.get("cell-1")?.editCount).toBe(3)
    })
  })
})
