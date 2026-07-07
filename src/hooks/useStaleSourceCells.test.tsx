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

  // QA-BUG-3: the lazy-pull sync and the stale-source read race — the read
  // can land before the mirror's writes are visible, showing a transient
  // wrong-tone badge. A single delayed re-fetch after the sync settles lands
  // the post-sync truth without a manual reload.
  it("schedules exactly one delayed re-fetch after the lazy-pull sync settles (QA-BUG-3)", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValueOnce(makeResponse(["c1"], { ancestorBehind: true }))
      const { result } = renderHook(() =>
        useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
      )
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(result.current.ancestorBehind).toBe(true)

      // The sync's mirror commit is now "done" server-side; the next read
      // should reflect the settled (post-sync) truth.
      fetchMock.mockResolvedValueOnce(makeResponse([], { ancestorBehind: false }))

      // Advance past POST_SYNC_REFETCH_DELAY_MS (2500ms) — triggerLinkSync's
      // fetch mock resolves on the next microtask, so flush that first.
      await vi.advanceTimersByTimeAsync(2600)

      await vi.waitFor(() => expect(result.current.ancestorBehind).toBe(false))
      expect(fetchMock).toHaveBeenCalledTimes(2)

      // No further re-fetches beyond the one scheduled follow-up.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels the pending delayed re-fetch on unmount (QA-BUG-3)", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValueOnce(makeResponse(["c1"]))
      const { unmount } = renderHook(() =>
        useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
      )
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

      unmount()
      await vi.advanceTimersByTimeAsync(5000)

      // The unmounted hook's scheduled re-fetch must not fire.
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // QA-BUG-2 (FRO-479 push accelerator): syncNow is the awaitable path the
  // link.upstream-changed handler uses so it can revalidate CELLS after the
  // sync resolves, not just the staleness badge.
  it("syncNow() awaits the mirror-sync POST, THEN revalidates staleness", async () => {
    let resolveFetch!: (value: Response) => void
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve }),
    )
    fetchMock.mockResolvedValueOnce(makeResponse([]))
    const { result } = renderHook(() =>
      useStaleSourceCells({ projectId: "p1", fileId: "f1", getToken }),
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fetchMock.mockResolvedValueOnce(makeResponse(["c9"]))
    const syncPromise = result.current.syncNow()

    // The stale-source GET must not have refired yet — syncNow awaits the
    // POST /link/sync response before revalidating.
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch(new Response(JSON.stringify({ ranSync: true }), { status: 200 }))
    await syncPromise

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.staleCellIds.has("c9")).toBe(true))
    fetchSpy.mockRestore()
  })
})
