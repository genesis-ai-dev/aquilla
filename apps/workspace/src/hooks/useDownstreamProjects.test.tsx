import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

const fetchMock =
  vi.fn<(projectId: string, jwt: string) => Promise<Array<{ id: string; name?: string }>>>()

vi.mock("@/lib/sync/source-linking-read", () => ({
  fetchProjectDownstreams: (...args: unknown[]) =>
    fetchMock(...(args as Parameters<typeof fetchMock>)),
  SourceLinkingError: class SourceLinkingError extends Error {
    status: number
    body: string
    constructor(status: number, body: string) {
      super(body)
      this.status = status
      this.body = body
      this.name = "SourceLinkingError"
    }
  },
}))

import { useDownstreamProjects } from "./useDownstreamProjects"
import { SourceLinkingError } from "@/lib/sync/source-linking-read"

beforeEach(() => {
  fetchMock.mockReset()
})

describe("useDownstreamProjects", () => {
  it("returns the downstream list on success", async () => {
    fetchMock.mockResolvedValueOnce([
      { id: "d1", name: "Target FR" },
      { id: "d2" },
    ])
    const { result } = renderHook(() =>
      useDownstreamProjects({ projectId: "p1", getToken: () => "jwt" }),
    )
    await waitFor(() => expect(result.current.downstreams).toHaveLength(2))
    expect(result.current.isError).toBe(false)
    expect(result.current.downstreams[0]).toEqual({ id: "d1", name: "Target FR" })
  })

  it("returns [] without calling fetch when projectId is null", async () => {
    const { result } = renderHook(() =>
      useDownstreamProjects({ projectId: null, getToken: () => "jwt" }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.downstreams).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("flags isError=true when no JWT is available", async () => {
    const { result } = renderHook(() =>
      useDownstreamProjects({ projectId: "p1", getToken: () => null }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("treats 403 as empty (not an error)", async () => {
    fetchMock.mockRejectedValueOnce(new SourceLinkingError(403, "forbidden"))
    const { result } = renderHook(() =>
      useDownstreamProjects({ projectId: "p1", getToken: () => "jwt" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.downstreams).toEqual([])
    expect(result.current.isError).toBe(false)
  })

  it("flags isError=true on a non-403 fetch error", async () => {
    fetchMock.mockRejectedValueOnce(new SourceLinkingError(500, "boom"))
    const { result } = renderHook(() =>
      useDownstreamProjects({ projectId: "p1", getToken: () => "jwt" }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it("refresh() triggers a second fetch", async () => {
    fetchMock.mockResolvedValueOnce([])
    const { result } = renderHook(() =>
      useDownstreamProjects({ projectId: "p1", getToken: () => "jwt" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    fetchMock.mockResolvedValueOnce([{ id: "x" }])
    act(() => { result.current.refresh() })
    await waitFor(() => expect(result.current.downstreams).toEqual([{ id: "x" }]))
  })
})
