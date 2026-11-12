// AQU-2160: a file opened from its direct link counted another language's
// recordings.
//
// On a direct link the editor first opens in the default language ('') and a
// moment later moves to the language it should open in. That starts two reads
// back to back, one per language. Each read awaited the outbox rehydrate step
// BEFORE claiming its turn, so whichever rehydrate finished last claimed the
// later turn: when the default language's finished last, the right language's
// read was thrown away as superseded and the default language's answer stayed,
// settled under the wrong key, so `hasLoaded` never turned true for the
// language on screen.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

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

// The rehydrate step, held open so the test decides the order it finishes in.
const rehydrate = vi.hoisted(() => ({ pending: [] as Array<() => void> }))
vi.mock("@/lib/audio/audio-attachments-bus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/audio-attachments-bus")>()),
  rehydrateShadowsFromOutbox: () => new Promise<void>((resolve) => { rehydrate.pending.push(resolve) }),
}))

import { useFileAudioAttachments } from "./useFileAudioAttachments"

const TAKE: AudioAttachmentOut = {
  audioId: "audio-c1-100-take.webm", url: "frontier-audio://take", slot: "recording",
  mimeType: "audio/webm", voiceId: null, referenceAudioId: null,
  durationMs: 2000, trimStartMs: null, trimEndMs: null,
}
const withTake: { cells: Record<string, CellAudioEntry> } = {
  cells: {
    c1: {
      attachments: { [TAKE.audioId]: TAKE }, selectedAudioId: TAKE.audioId,
      selectedGeneratedVoiceAudioId: null, audioTimings: {},
    },
  },
}

beforeEach(() => {
  rehydrate.pending.length = 0
  fetchMock.mockReset()
  // The default language has no recordings; Swahili has one.
  fetchMock.mockImplementation(async (_p: string, _f: string, _t: string, lane: string) =>
    lane === "sw" ? withTake : { cells: {} })
})

describe("a direct link keeps the language on screen's recordings (AQU-2160)", () => {
  it("keeps the later language's answer when the earlier language's rehydrate finishes last", async () => {
    const view = renderHook(({ lane }: { lane: string }) => useFileAudioAttachments("p1", "f1", lane), {
      initialProps: { lane: "" },
    })
    await waitFor(() => expect(rehydrate.pending).toHaveLength(1))
    // The editor moves to the language it should open in.
    view.rerender({ lane: "sw" })
    await waitFor(() => expect(rehydrate.pending).toHaveLength(2))

    // Swahili's rehydrate finishes first, the default language's last.
    await act(async () => { rehydrate.pending[1]() })
    await act(async () => { rehydrate.pending[0]() })

    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true))
    expect(Object.keys(view.result.current.byCellId.get("c1")?.attachments ?? {})).toEqual([TAKE.audioId])
    // Only Swahili's read reached the server: the superseded one stopped first.
    expect(fetchMock.mock.calls.map((call) => call[3])).toEqual(["sw"])
  })
})
