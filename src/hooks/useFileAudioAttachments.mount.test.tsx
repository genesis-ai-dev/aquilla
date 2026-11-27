// AQU-2655: ProjectWorkspace and EditorTable each mount this hook for the open
// file, and some of them only after first paint. A mount that arrived while the
// first read was still on its way — but after the 250 ms join window — queued
// a second read of its own behind it, so opening a file cost one more
// `audio-attachments` request than it had readers asking anything new.
//
// A mount is not news that the takes changed: it joins the read already on its
// way. A poke (something WAS written) still gets a read that starts after the
// one in flight; that rule is pinned in request-coalescer.test.ts, and only the
// mount effect passes `joinLatest`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
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
  getOutboxFileAudioRecords: async () => [],
  requeueOutboxEvents: async () => {},
  subscribeToOutbox: () => () => {},
}))

import { useFileAudioAttachments } from "./useFileAudioAttachments"

type Answer = { cells: Record<string, CellAudioEntry> }
const answer = (selectedAudioId: string | null): Answer => ({
  cells: { c1: { attachments: {}, selectedAudioId, selectedGeneratedVoiceAudioId: null, audioTimings: {} } },
})

let clock = 1_000_000
beforeEach(() => {
  fetchMock.mockReset()
  vi.spyOn(Date, "now").mockImplementation(() => clock)
})
afterEach(() => { vi.restoreAllMocks() })

function hangingRead() {
  let resolve!: (value: Answer) => void
  fetchMock.mockImplementationOnce(() => new Promise<Answer>((r) => { resolve = r }))
  return (value: Answer) => resolve(value)
}

describe("instances that mount while the file's read is on its way", () => {
  it("a late mount joins the read in flight instead of queueing its own", async () => {
    const finish = hangingRead()
    const first = renderHook(() => useFileAudioAttachments("p1", "f-mount", "fr"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    clock += 2_000 // well past the join window: first paint has happened
    const late = renderHook(() => useFileAudioAttachments("p1", "f-mount", "fr"))
    await act(async () => { finish(answer("take-1")) })
    await waitFor(() => expect(late.result.current.hasLoaded).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.result.current.byCellId.get("c1")?.selectedAudioId).toBe("take-1")
    expect(late.result.current.byCellId.get("c1")?.selectedAudioId).toBe("take-1")
  })
})
