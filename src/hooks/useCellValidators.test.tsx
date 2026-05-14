// Phase 2b tests for useCellValidators. Vanilla useState pattern; mocks
// the global `fetch` directly because the route is small enough that we
// don't bother extracting a dedicated wrapper.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useCellValidators } from "./useCellValidators"

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

const TOKEN_FN = vi.fn().mockResolvedValue("test-token")

const VALIDATORS_RESPONSE = [
  { editEventId: "evt-2", username: "bob", isActive: true, decidedTs: 1700000020000 },
  { editEventId: "evt-1", username: "alice", isActive: false, decidedTs: 1700000010000 },
]

describe("useCellValidators (Phase 2b)", () => {
  it("returns validators in server order (decidedTs DESC) on happy path", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ validators: VALIDATORS_RESPONSE }), { status: 200 }),
    ) as unknown as typeof fetch

    const { result } = renderHook(() =>
      useCellValidators({
        enabled: true,
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.validators).toHaveLength(2)
    expect(result.current.validators[0].username).toBe("bob")
    expect(result.current.validators[1].username).toBe("alice")
  })

  it("returns isError when token is null and never fetches", async () => {
    const noTokenFn = vi.fn().mockResolvedValue(null)
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellValidators({
        enabled: true,
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile: noTokenFn,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.validators).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("returns isError on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 }),
    ) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellValidators({
        enabled: true,
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.validators).toEqual([])
  })

  it("does not fetch when disabled", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellValidators({
        enabled: false,
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.validators).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("does not fetch when cellId is null", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellValidators({
        enabled: true,
        fileId: "file-abc",
        cellId: null,
        getTokenForFile: TOKEN_FN,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.validators).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("includes fileId and cellId in request URL", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ validators: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellValidators({
        enabled: true,
        fileId: "file-XYZ",
        cellId: "cell-ABC",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const url = call[0] as string
    expect(url).toContain("fileId=file-XYZ")
    expect(url).toContain("cellId=cell-ABC")
  })

  it("revalidate() triggers a refetch", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ validators: [VALIDATORS_RESPONSE[0]] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ validators: VALIDATORS_RESPONSE }), { status: 200 })) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellValidators({
        enabled: true,
        fileId: "file-abc",
        cellId: "cell-1",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.validators).toHaveLength(1))
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.validators).toHaveLength(2))
  })
})
