import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import type { StaleSourceResponse } from "@/lib/sync/stale-source-read-types"

function makeResponse(staleCellIds: string[], extra: Partial<StaleSourceResponse> = {}): StaleSourceResponse {
  return {
    projectId: "p1",
    fileId: "f1",
    staleCellIds,
    tombstonedCellIds: [],
    upstreamStaleCellIds: [],
    upstreamProjectId: null,
    behindSeq: null,
    ancestorBehind: false,
    ...extra,
  }
}

const fetchMock =
  vi.fn<(projectId: string, fileId: string, jwt: string) => Promise<StaleSourceResponse>>()

vi.mock("@/lib/sync/stale-source-read", () => ({
  fetchStaleSourceResponse: (...args: unknown[]) =>
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
  // FRO-476: the hook fires a fire-and-forget lazy-pull trigger
  // (POST .../link/sync) alongside the stale-source fetch — stub the global
  // fetch so that call resolves quietly instead of hitting the network.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
})

describe("useStaleSourceCells", () => {
  it("returns the set of stale cell ids on success", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(["c1", "c3", "c7"]))
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
    fetchMock.mockResolvedValueOnce(makeResponse(["c1"]))
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
    )
    await waitFor(() => expect(result.current.staleCellIds.has("c1")).toBe(true))
    fetchMock.mockResolvedValueOnce(makeResponse([]))
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.staleCellIds.size).toBe(0))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("surfaces tombstonedCellIds and behindSeq from the response (FRO-476)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(["c1"], { tombstonedCellIds: ["c9"], behindSeq: { upstream: 10, cursor: 5 } }),
    )
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
    )
    await waitFor(() => expect(result.current.tombstonedCellIds.has("c9")).toBe(true))
    expect(result.current.behindSeq).toEqual({ upstream: 10, cursor: 5 })
  })

  it("surfaces upstreamStaleCellIds and ancestorBehind from the response (FRO-477)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(["c1"], { upstreamStaleCellIds: ["c2"], ancestorBehind: true }),
    )
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
    )
    await waitFor(() => expect(result.current.upstreamStaleCellIds.has("c2")).toBe(true))
    expect(result.current.staleCellIds.has("c1")).toBe(true)
    expect(result.current.ancestorBehind).toBe(true)
  })

  it("fires the mirror-sync lazy-pull trigger alongside the stale-source fetch (FRO-476 §7)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse([]))
    renderHook(() => useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const triggerCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]).includes("/link/sync"),
    )
    expect(triggerCall).toBeTruthy()
    expect((triggerCall![1] as RequestInit).method).toBe("POST")
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
