import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useCellValidators } from "./useCellValidators"

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

/** Server returns by decided_ts DESC. */
const VALIDATORS_RESPONSE = [
  { editEventId: "evt-2", username: "bob", isActive: true, decidedTs: 1700000020000 },
  { editEventId: "evt-1", username: "alice", isActive: false, decidedTs: 1700000010000 },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useCellValidators", () => {
  it("returns validators in server order (decidedTs DESC) on happy path", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ validators: VALIDATORS_RESPONSE }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(false)
    expect(result.current.validators).toHaveLength(2)
    // Server order (newest first) preserved
    expect(result.current.validators[0].username).toBe("bob")
    expect(result.current.validators[0].decidedTs).toBe(1700000020000)
    expect(result.current.validators[1].username).toBe("alice")
  })

  it("returns correct shape for each validator", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ validators: [VALIDATORS_RESPONSE[0]] }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const v = result.current.validators[0]
    expect(v.editEventId).toBe("evt-2")
    expect(v.username).toBe("bob")
    expect(v.isActive).toBe(true)
    expect(v.decidedTs).toBe(1700000020000)
  })

  it("returns empty array and isError when token is null", async () => {
    const noTokenFn = vi.fn().mockResolvedValue(null)

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: noTokenFn,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(true)
    expect(result.current.validators).toHaveLength(0)
  })

  it("returns empty array and isError on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: true,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.isError).toBe(true)
    expect(result.current.validators).toHaveLength(0)
  })

  it("does not fetch when enabled is false", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: false,
          fileId: "file-abc",
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.validators).toHaveLength(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("does not fetch when fileId is null", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: true,
          fileId: null,
          cellId: "cell-1",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.validators).toHaveLength(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("does not fetch when cellId is null", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: true,
          fileId: "file-abc",
          cellId: null,
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.validators).toHaveLength(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("includes fileId and cellId in request URL", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ validators: [] }), { status: 200 })
    ) as unknown as typeof fetch

    const { result } = renderHook(
      () =>
        useCellValidators({
          enabled: true,
          fileId: "file-XYZ",
          cellId: "cell-ABC",
          getTokenForFile: TOKEN_FN,
        }),
      { wrapper: makeWrapper() }
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const url = call[0] as string
    expect(url).toContain("fileId=file-XYZ")
    expect(url).toContain("cellId=cell-ABC")
  })
})
