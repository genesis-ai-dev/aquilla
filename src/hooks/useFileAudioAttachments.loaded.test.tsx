// `hasLoaded`: whether an empty map means "no recordings" or "not read yet".
//
// The 3G pass (Sam, 2026-10-01) found every line's audio check saying "No
// audio to validate" for seconds after a file opened, then changing its mind
// when the read landed. The gutter now waits on this flag, so it has to be
// false exactly while an answer is outstanding — and never flip back on the
// refetches every vote and recording trigger, or each one would blank the
// whole gutter.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

const auth = vi.hoisted(() => ({
  session: { jwt: "tok", username: "sam" } as { jwt: string; username: string } | null,
  loading: false,
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: auth.session, loading: auth.loading }),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  makeAudioSyncTokenFetcher: () => async () => "sync-tok",
}))
const fetchMock = vi.fn()
vi.mock("@/lib/sync/cell-audio-read", () => ({
  fetchFileAudioAttachments: (...args: unknown[]) => fetchMock(...args),
}))
vi.mock("@/lib/sync/outbox", () => ({
  getOutboxRecords: async () => [],
  subscribeToOutbox: () => () => {},
}))

import { useFileAudioAttachments } from "./useFileAudioAttachments"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"

/** A read the test answers when it chooses. */
function deferredRead() {
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const NOTHING = { cells: {} }

beforeEach(() => {
  fetchMock.mockReset()
  auth.session = { jwt: "tok", username: "sam" }
  auth.loading = false
})

describe("useFileAudioAttachments — hasLoaded", () => {
  it("is false until the first read comes back, then stays true through a refetch", async () => {
    const first = deferredRead()
    fetchMock.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-a"))
    expect(result.current.hasLoaded).toBe(false)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await act(async () => { first.resolve(NOTHING) })
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))

    // A vote or a recording pokes the file: the refetch must not blank it.
    const second = deferredRead()
    fetchMock.mockReturnValueOnce(second.promise)
    act(() => { notifyAudioAttachmentsChanged("file-a") })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.hasLoaded).toBe(true)
    await act(async () => { second.resolve(NOTHING) })
  })

  it("reads as not loaded the moment the file changes, until that file's read lands", async () => {
    fetchMock.mockResolvedValueOnce(NOTHING)
    const { result, rerender } = renderHook(({ fileId }) => useFileAudioAttachments("proj-1", fileId), {
      initialProps: { fileId: "file-b" },
    })
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))

    const next = deferredRead()
    fetchMock.mockReturnValueOnce(next.promise)
    rerender({ fileId: "file-c" })
    expect(result.current.hasLoaded).toBe(false)
    await act(async () => { next.resolve(NOTHING) })
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  })

  it("counts a failed read as an answer, so nothing waits on it forever", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-d"))
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    expect(result.current.byCellId.size).toBe(0)
  })

  it("waits while the session is still loading, and not once nobody is signed in", () => {
    auth.session = null
    auth.loading = true
    const { result, rerender } = renderHook(() => useFileAudioAttachments("proj-1", "file-e"))
    expect(result.current.hasLoaded).toBe(false)

    auth.loading = false
    rerender()
    expect(result.current.hasLoaded).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("has nothing to wait for without a file", () => {
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", null))
    expect(result.current.hasLoaded).toBe(true)
  })
})
