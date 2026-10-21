// AQU-1575: removing noise from a WAV take must not quietly downgrade it to
// compressed audio. A WAV in comes back a WAV; every other input is written as
// Opus, as it always was. RNNoise itself runs in a real-time Web Audio graph
// that happy-dom does not have, so the denoiser is faked here and the browser
// walk covers the graph.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload")>()
  return {
    ...actual,
    fetchCellAudio: vi.fn(async () => new Uint8Array([1, 2, 3])),
    uploadCellAudio: vi.fn(async ({ audioId, ext, blob }: { audioId: string; ext: string; blob: Blob }) => ({
      audioId, ext, url: `frontier-audio://${audioId}.${ext}`, sizeBytes: blob.size,
    })),
    deleteCellAudio: vi.fn(async () => {}),
  }
})
vi.mock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("./decode-mono", () => ({
  TARGET_RATE: 48000,
  decodeToMono48k: vi.fn(async () => new Float32Array(480)),
}))
vi.mock("./denoise", () => ({ denoiseMono48k: vi.fn() }))
vi.mock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: vi.fn(async () => "evt-1") }))
vi.mock("./audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: vi.fn(),
  notifyAudioAttachmentsChanged: vi.fn(),
}))
vi.mock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
vi.mock("./project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("./transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))

import { denoiseTake } from "./denoise-take"
import { denoiseMono48k } from "./denoise"
import { uploadCellAudio } from "./upload"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import type { FrontierSession } from "@/lib/frontier/types"

const mockDenoise = vi.mocked(denoiseMono48k)

const run = (sourceExt: string) =>
  denoiseTake({
    projectId: "p1",
    fileId: "f1",
    cellId: "c1",
    sourceAudioId: `audio-c1-1.${sourceExt}`,
    sourceUrl: `frontier-audio://audio-c1-1.${sourceExt}`,
    author: "sam",
    session: { jwt: "jwt" } as FrontierSession,
  })

beforeEach(() => {
  vi.clearAllMocks()
  mockDenoise.mockImplementation(async (_samples, opts) =>
    opts?.output === "wav"
      ? { blob: new Blob([new Uint8Array(44)], { type: "audio/wav" }), durationMs: 10, mimeType: "audio/wav" }
      : {
          blob: new Blob([new Uint8Array(8)], { type: "audio/webm;codecs=opus" }),
          durationMs: 10,
          mimeType: "audio/webm;codecs=opus",
        },
  )
})

describe("the format of a cleaned take (AQU-1575)", () => {
  it("keeps a WAV take a WAV", async () => {
    const result = await run("wav")
    expect(mockDenoise).toHaveBeenCalledWith(expect.any(Float32Array), { output: "wav" })
    expect(vi.mocked(uploadCellAudio)).toHaveBeenCalledWith(expect.objectContaining({ ext: "wav" }))
    expect(result.audioId).toMatch(/^dn-.*\.wav$/)
    expect(vi.mocked(emitCellAudioAttach)).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "audio/wav", referenceAudioId: "audio-c1-1.wav" }),
    )
  })

  it("writes a compressed take as Opus, as before", async () => {
    const result = await run("webm")
    expect(mockDenoise).toHaveBeenCalledWith(expect.any(Float32Array), { output: "opus" })
    expect(vi.mocked(uploadCellAudio)).toHaveBeenCalledWith(expect.objectContaining({ ext: "webm" }))
    expect(result.audioId).toMatch(/^dn-.*\.webm$/)
  })

  it("writes an mp3 as Opus too — only a WAV original is kept a WAV", async () => {
    await run("mp3")
    expect(mockDenoise).toHaveBeenCalledWith(expect.any(Float32Array), { output: "opus" })
  })
})
