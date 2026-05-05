import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useCellsAuditStats } from "./useCellsAuditStats"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/sync/sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.com",
}))

const originalFetch = global.fetch

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  global.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
  return Wrapper
}

const TOKEN_FN = vi.fn().mockResolvedValue("test-token")

const STATS_RESPONSE = [
  { cellId: "cell-1", editCount: 3, contentHash: "abc123" },
  { cellId: "cell-2", editCount: 7, contentHash: "def456" },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useCellsAuditStats", () => {
  it("returns a Map keyed by cellId on happy path", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(false)
    expect(result.current.byCellId.size).toBe(2)
    expect(result.current.byCellId.get("cell-1")).toEqual({
      cellId: "cell-1",
      editCount: 3,
      contentHash: "abc123",
    })
    expect(result.current.byCellId.get("cell-2")).toEqual({
      cellId: "cell-2",
      editCount: 7,
      contentHash: "def456",
    })
  })

  it("returns empty Map and isError when token is null", async () => {
    const noTokenFn = vi.fn().mockResolvedValue(null)
    const mockFetch = vi.fn()
    global.fetch = mockFetch as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: noTokenFn,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(true)
    expect(result.current.byCellId.size).toBe(0)
    // fetch should NOT have been called since we never got a token
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns empty Map and isError on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(true)
    expect(result.current.byCellId.size).toBe(0)
  })

  it("does not fetch when enabled is false", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellsAuditStats({
          enabled: false,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    // Should not be loading and no error when disabled
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isError).toBe(false)
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("does not fetch when fileId is null", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellsAuditStats({
          enabled: true,
          fileId: null,
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.isError).toBe(false)
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("sends Authorization header with Bearer token", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ cells: [] }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const init = call[1] as RequestInit
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" })
  })
})
