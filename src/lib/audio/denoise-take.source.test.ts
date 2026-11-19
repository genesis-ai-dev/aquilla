// AQU-2327: cleaning a whole take keeps its track, name, kept part, places and
// level (it used to land on the main track with its margins back).
import { describe, expect, it, vi } from "vitest"

const sent = vi.hoisted(() => ({ attach: [] as Record<string, unknown>[], place: [] as unknown[], gain: [] as unknown[], even: [] as unknown[] }))
vi.mock("./upload", () => ({
  buildDenoisedAudioId: () => "dn-x",
  uploadCellAudio: vi.fn(async () => ({ audioId: "dn-x", ext: "webm", url: "frontier-audio://dn-x.webm" })),
  deleteCellAudio: vi.fn(),
  fetchCellAudio: vi.fn(async () => new Uint8Array(4)),
  parseFrontierAudioUrl: () => ({ audioId: "t", ext: "webm" }),
}))
vi.mock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("./decode-mono", () => ({ decodeToMono48k: vi.fn(async () => new Float32Array(48000)) }))
vi.mock("./denoise", () => ({ denoiseMono48k: vi.fn(async () => ({ blob: new Blob(["x"], { type: "audio/webm" }), durationMs: 1000, mimeType: "audio/webm" })) }))
vi.mock("./audio-attachments-bus", () => ({ injectOptimisticAudioAttachment: vi.fn(), notifyAudioAttachmentsChanged: vi.fn() }))
vi.mock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "jwt" }))
vi.mock("./project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("./transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/history/take-steps", () => ({ recordTakeAdded: vi.fn() }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (x: Record<string, unknown>) => (sent.attach.push(x), "e1")),
  emitCellAudioPlace: vi.fn(async (x: unknown) => (sent.place.push(x), "e2")),
  emitCellAudioGain: vi.fn(async (x: unknown) => (sent.gain.push(x), "e3")),
  emitCellAudioEven: vi.fn(async (x: unknown) => (sent.even.push(x), "e4")),
}))

import { denoiseTake } from "./denoise-take"

describe("Remove noise on a whole take", () => {
  it("keeps the take's track, name, kept part, places and level", async () => {
    await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never,
      source: { slot: "track-2", label: "Take 4", trimStartMs: 200, trimEndMs: 900, targetOffsetMs: 50, recordingsOffsetMs: null, gainDb: -3 },
    })
    expect(sent.attach[0]).toMatchObject({ slot: "track-2", label: "Take 4", trimStartMs: 200, trimEndMs: 900, referenceAudioId: "t.webm" })
    expect(sent.place[0]).toMatchObject({ targetOffsetMs: 50, recordingsOffsetMs: null })
    expect(sent.gain[0]).toMatchObject({ gainDb: -3, fadeInMs: null })
  })

  // AQU-2664 review M3: an evened-out take stays evened out when cleaned. The
  // cleaned audio is not measured here (it was encoded, not kept): it plays at
  // its own volume until Even out measures it — the fallback.
  it("carries the take's evening out to the cleaned take", async () => {
    sent.even.length = 0
    await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never,
      source: { slot: "recording", gainDb: -3, evenTargetLufs: -16 },
    })
    expect(sent.even).toEqual([expect.objectContaining({ audioId: "dn-x.webm", evenTargetLufs: -16 })])
  })
})
