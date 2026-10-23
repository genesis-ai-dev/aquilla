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
// Mutable so a test can make ONE mint fail (AQU-2132), the way a token POST
// that loses the race on page load does.
const token = vi.hoisted(() => ({ next: [] as (string | null)[] }))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  makeAudioSyncTokenFetcher: () => async () => (token.next.length > 0 ? token.next.shift()! : "sync-tok"),
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
  token.next = []
  auth.session = { jwt: "tok", username: "sam" }
  auth.loading = false
})

/** One cell with one selected, once-validated take. */
const ONE_TAKE = {
  cells: {
    "cell-1": {
      attachments: {
        "audio-cell-1-1700000000000-abc": {
          audioId: "audio-cell-1-1700000000000-abc",
          url: "frontier-audio://audio-cell-1-1700000000000-abc.webm",
          slot: "recording",
          mimeType: "audio/webm",
          validatorCount: 1,
        },
      },
      selectedBySlot: { recording: "audio-cell-1-1700000000000-abc" },
      selectedAudioId: "audio-cell-1-1700000000000-abc",
      selectedGeneratedVoiceAudioId: null,
      audioTimings: {},
    },
  },
}

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

// AQU-2132: an empty map after a read that could not answer was published as
// "this file has no recordings" and never revisited — the deps are stable once
// the session lands, and only a local take change pokes the bus. The editor
// footer, the chapter picker and the open file's sidebar chapter grid all count
// audio off this map, so one lost read on page load left all three reading text
// figures for the rest of the tab's life.
describe("useFileAudioAttachments — a failed read is not the last word (AQU-2132)", () => {
  it("retries a read that threw, and reports the takes the retry returns", async () => {
    fetchMock.mockRejectedValueOnce(new Error("503"))
    fetchMock.mockResolvedValueOnce(ONE_TAKE)
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-r1"))

    await waitFor(() => expect(result.current.byCellId.size).toBe(1))
    expect(result.current.byCellId.get("cell-1")?.selectedAudioId)
      .toBe("audio-cell-1-1700000000000-abc")
  })

  it("retries a read whose sync-token mint came back empty", async () => {
    token.next = [null]
    fetchMock.mockResolvedValue(ONE_TAKE)
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-r2"))

    // The failed mint makes no request at all, so the map can only fill if the
    // read is attempted again.
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps the answer it already has when a refetch of the same file fails", async () => {
    fetchMock.mockResolvedValueOnce(ONE_TAKE)
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-r3"))
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    fetchMock.mockRejectedValue(new Error("503"))
    act(() => { notifyAudioAttachmentsChanged("file-r3") })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // A transient error is not news that the takes went away.
    expect(result.current.byCellId.size).toBe(1)
  })

  it("blanks the map when the read that failed was for a different file", async () => {
    fetchMock.mockResolvedValueOnce(ONE_TAKE)
    const { result, rerender } = renderHook(
      ({ fileId }) => useFileAudioAttachments("proj-1", fileId),
      { initialProps: { fileId: "file-r4" } },
    )
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))

    // The old map is a lie about the file now on screen, whatever its read did.
    fetchMock.mockRejectedValue(new Error("503"))
    rerender({ fileId: "file-r5" })
    await waitFor(() => expect(result.current.byCellId.size).toBe(0))
  })

  it("gives up after a bounded number of attempts rather than retrying forever", async () => {
    fetchMock.mockRejectedValue(new Error("503"))
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-r6"))
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))

    // 1 initial read + READ_RETRY_DELAYS_MS.length retries, then it stops.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4), { timeout: 8000 })
    await new Promise((r) => setTimeout(r, 500))
    expect(fetchMock).toHaveBeenCalledTimes(4)
  }, 15000)
})
