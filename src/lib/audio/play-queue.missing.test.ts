// Surface-on-select behavior (AQU-660 / reported bug): pressing Play on a
// SELECTED missing clip must surface the missing state ON THAT CLIP, not skip
// forward and silently play a neighbour. Auto/plain-play-all still skips a
// missing clip to keep going. Both paths reuse the shared 404 sentinel; the
// contrast is which cellId ends up in the error state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

const fetchCellAudio = vi.fn()
vi.mock("./upload", async () => {
  const actual = await vi.importActual<typeof import("./upload")>("./upload")
  return {
    ...actual,
    fetchCellAudio: (...args: unknown[]) => fetchCellAudio(...args),
    // No stream URL → resolveAudioSrc falls through to the full-bytes fetch,
    // which is where the 404 sentinel surfaces.
    getCellAudioStreamUrl: async () => null,
  }
})
vi.mock("./bytes-cache", () => ({
  audioCacheGet: async () => null,
  audioCachePut: async () => undefined,
}))
vi.mock("./sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

import { getQueueState, MISSING_AUDIO_MESSAGE, startQueue, stopQueue } from "./play-queue"
import { buildFrontierAudioUrl } from "./upload"

const session = { jwt: "jwt", username: "u" } as unknown as FrontierSession

function missingCell(id: string): CellData {
  const audioId = `audio-${id}`
  return {
    id, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "unvalidated",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    selectedAudioId: audioId,
    attachments: { [audioId]: { url: buildFrontierAudioUrl(audioId, "webm"), type: "audio" } },
  } as unknown as CellData
}

describe("play-queue missing-clip behavior", () => {
  beforeEach(() => {
    fetchCellAudio.mockReset()
    // Every clip's bytes are gone (permanent 404 sentinel).
    fetchCellAudio.mockRejectedValue(
      Object.assign(new Error("audio not found (404): gone"), { status: 404 }),
    )
  })
  afterEach(() => { stopQueue() })

  it("explicit start on a selected missing clip surfaces it there — does NOT skip to the neighbour", async () => {
    const cells = [missingCell("c0"), missingCell("c1")]
    startQueue({ cells, projectId: "p1", session }, 0, /* explicit */ true)

    await vi.waitFor(() => expect(getQueueState().kind).toBe("error"))
    const state = getQueueState()
    expect(state.kind === "error" && state.message).toBe(MISSING_AUDIO_MESSAGE)
    // Surfaced at the SELECTED clip (c0), not hopped forward to c1.
    expect(state.kind === "error" && state.cellId).toBe("c0")
  })

  it("plain play-all skips a missing clip forward, surfacing only when none remain", async () => {
    const cells = [missingCell("c0"), missingCell("c1")]
    startQueue({ cells, projectId: "p1", session }, 0, /* explicit */ false)

    await vi.waitFor(() => expect(getQueueState().kind).toBe("error"))
    const state = getQueueState()
    expect(state.kind === "error" && state.message).toBe(MISSING_AUDIO_MESSAGE)
    // Skipped c0 → c1; surfaced on the LAST clip once nothing playable remained.
    expect(state.kind === "error" && state.cellId).toBe("c1")
  })
})
