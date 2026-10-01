// `hasLoaded` on the cue-link read: one of the three reads a dubbing file's
// audio check waits on before it may say a line has no audio (Sam, 2026-10-01,
// from the 3G pass). It must be false only while the first answer is
// outstanding — a refresh after linking keeps the old links on screen, and
// must not blank every line's check while it runs.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  makeAudioSyncTokenFetcher: () => async () => "sync-tok",
}))
const fetchMock = vi.fn()
vi.mock("@/lib/sync/cell-links-read", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchFileCellLinks: (...args: unknown[]) => fetchMock(...args),
}))

import { useFileCellLinks } from "./useFileCellLinks"

function deferredRead() {
  let resolve!: (v: unknown) => void
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}
const NO_LINKS = { links: [], rejected: [] }

beforeEach(() => fetchMock.mockReset())

describe("useFileCellLinks — hasLoaded", () => {
  it("is false until the first read comes back, and a refresh does not undo it", async () => {
    const first = deferredRead()
    fetchMock.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useFileCellLinks({ projectId: "proj-1", fileId: "subs" }))
    expect(result.current.hasLoaded).toBe(false)
    await act(async () => { first.resolve(NO_LINKS) })
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))

    const second = deferredRead()
    fetchMock.mockReturnValueOnce(second.promise)
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.isLoading).toBe(true))
    expect(result.current.hasLoaded).toBe(true)
    await act(async () => { second.resolve(NO_LINKS) })
  })

  it("counts a failed read as an answer", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useFileCellLinks({ projectId: "proj-1", fileId: "subs-2" }))
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    expect(result.current.error).toBeDefined()
  })

  it("has nothing to wait for without a file (no cue sibling)", () => {
    const { result } = renderHook(() => useFileCellLinks({ projectId: "proj-1", fileId: null }))
    expect(result.current.hasLoaded).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
