import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useCellEditHistory } from "./useCellEditHistory"

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

/** Server returns newest-first (descending serverTs). */
const SERVER_EVENTS = [
  {
    kind: "cell.commit",
    serverTs: 1700000030000,
    author: "alice",
    payload: { value: "third edit" },
  },
  {
    kind: "cell.commit",
    serverTs: 1700000020000,
    author: "bob",
    payload: { value: "second edit" },
  },
  {
    kind: "cell.commit",
    serverTs: 1700000010000,
    author: "alice",
    payload: { value: "first edit" },
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useCellEditHistory", () => {
  it("returns history entries in oldest-first order (reversed from server)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events: SERVER_EVENTS }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(false)
    expect(result.current.history).toHaveLength(3)
    // Oldest first (reversed from server's newest-first)
    expect(result.current.history[0].value).toBe("first edit")
    expect(result.current.history[1].value).toBe("second edit")
    expect(result.current.history[2].value).toBe("third edit")
  })

  it("maps server payload to CellHistoryEntry shape", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events: [SERVER_EVENTS[0]] }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const entry = result.current.history[0]
    expect(entry.timestamp).toBe(new Date(1700000030000).toISOString())
    expect(entry.value).toBe("third edit")
    expect(entry.source).toBe("human")
    expect(entry.author).toBe("alice")
    expect(entry.validated).toBe(false)
  })

  it("filters out non-cell.commit events", async () => {
    const events = [
      { kind: "cell.validate", serverTs: 1700000050000, author: "alice", payload: {} },
      ...SERVER_EVENTS,
      { kind: "cell.unvalidate", serverTs: 1700000000000, author: "bob", payload: {} },
    ]
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Only cell.commit events
    expect(result.current.history).toHaveLength(3)
    expect(result.current.history.every((e) => e.source === "human")).toBe(true)
  })

  it("returns empty array when no events for cell", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events: [] }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(false)
    expect(result.current.history).toHaveLength(0)
  })

  it("returns empty array and isError when token is null", async () => {
    const noTokenFn = vi.fn().mockResolvedValue(null)

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: noTokenFn,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(true)
    expect(result.current.history).toHaveLength(0)
  })

  it("returns empty array and isError on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Not Found", { status: 404 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(true)
    expect(result.current.history).toHaveLength(0)
  })

  it("does not fetch when enabled is false", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: false,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.history).toHaveLength(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("does not fetch when cellId is null", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: null,
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.history).toHaveLength(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("includes cellId and limit in query params", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events: [] }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellEditHistory({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-XYZ",
          limit: 25,
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const url = call[0] as string
    expect(url).toContain("cellId=cell-XYZ")
    expect(url).toContain("limit=25")
    expect(url).toContain("fileId=file-abc")
  })
})
