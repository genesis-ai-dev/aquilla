import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

const fetchMock =
  vi.fn<(projectId: string, fileId: string, jwt: string) => Promise<string[]>>()

vi.mock("@/lib/sync/stale-source-read", () => ({
  fetchStaleSourceCells: (...args: unknown[]) =>
    fetchMock(...(args as Parameters<typeof fetchMock>)),
  StaleSourceError: class StaleSourceError extends Error {
    status: number
    body: string
    constructor(status: number, body: string) {
      super(body)
      this.status = status
      this.body = body
      this.name = "StaleSourceError"
    }
  },
}))

import { useStaleSourceCells } from "./useStaleSourceCells"

const getToken = async () => "jwt"

beforeEach(() => {
  fetchMock.mockReset()
})

describe("useStaleSourceCells", () => {
  it("returns the set of stale cell ids on success", async () => {
    fetchMock.mockResolvedValueOnce(["c1", "c3", "c7"])
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
    )
    await waitFor(() => expect(result.current.staleCellIds.size).toBe(3))
    expect(result.current.staleCellIds.has("c1")).toBe(true)
    expect(result.current.staleCellIds.has("c2")).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it("returns an empty set without fetching when projectId is null", async () => {
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: null, fileId: "f1", getToken }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.staleCellIds.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("falls back to empty set on fetch error (soft signal)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.staleCellIds.size).toBe(0)
    expect(result.current.isError).toBe(true)
  })

  it("revalidate() refetches with the latest data", async () => {
    fetchMock.mockResolvedValueOnce(["c1"])
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
    )
    await waitFor(() => expect(result.current.staleCellIds.has("c1")).toBe(true))
    fetchMock.mockResolvedValueOnce([])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.staleCellIds.size).toBe(0))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("retries on null token without surfacing isError, then falls back quietly", async () => {
    const { result } = renderHook(() =>
      useStaleSourceCells({
        projectId: "p1",
        fileId: "f1",
        getToken: async () => null,
      }),
    )
    // First null shouldn't flip to error — staleness is a soft signal.
    await new Promise((r) => setTimeout(r, 100))
    expect(result.current.isError).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    // After ~6 backoff attempts the hook gives up and shows empty (no error).
    await waitFor(
      () => expect(result.current.staleCellIds.size).toBe(0),
      { timeout: 10_000 },
    )
    expect(result.current.isError).toBe(false)
  }, 12_000)
})
