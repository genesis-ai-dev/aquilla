import { beforeEach, describe, expect, it, vi } from "vitest"

const uploads: Array<{ audioId: string; ext: string; size: number }> = []
const attaches: Array<Record<string, unknown>> = []

vi.mock("@/lib/audio/upload", async (orig) => {
  const real = await orig<typeof import("@/lib/audio/upload")>()
  return {
    ...real,
    fetchCellAudio: vi.fn(async () => new Uint8Array(1000)),
    uploadCellAudio: vi.fn(async (args: { audioId: string; ext: string; blob: Blob }) => {
      uploads.push({ audioId: args.audioId, ext: args.ext, size: args.blob.size })
      return { audioId: args.audioId, ext: args.ext, url: real.buildFrontierAudioUrl(args.audioId, args.ext), sizeBytes: args.blob.size }
    }),
  }
})
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCacheGet: vi.fn(async () => null) }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => { attaches.push(input); return "ev" }),
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({ injectOptimisticAudioAttachment: vi.fn(), notifyAudioAttachmentsChanged: vi.fn() }))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "token" }))
vi.mock("@/lib/audio/decode-mono", () => ({
  TARGET_RATE: 1000,
  // 1000 "samples" a second: a recording of 1000 bytes is one second long.
  decodeToMono48k: vi.fn(async (bytes: Uint8Array) => Float32Array.from({ length: bytes.length }, (_, i) => i)),
  concatPcm: (clips: Float32Array[]) => {
    const out = new Float32Array(clips.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of clips) { out.set(c, at); at += c.length }
    return out
  },
}))
vi.mock("@/lib/audio/wav-encode", () => ({
  encodeWavPcm16: (samples: Float32Array) => new Blob([new Uint8Array(samples.length)]),
}))

import { joinTakePieces, wholeRecordingOf, type JoinPiece } from "./join-pieces"

const session = { jwt: "jwt", username: "dev", createdAt: "" } as never
const URL_A = "frontier-audio://audio-c1-1700000000000-a.wav"

beforeEach(() => {
  uploads.length = 0
  attaches.length = 0
})

describe("wholeRecordingOf", () => {
  const piece = (trimStartMs: number | null, trimEndMs: number | null, url = URL_A): JoinPiece => ({ audioId: `p${trimStartMs}`, url, trimStartMs, trimEndMs, durationMs: 1200 })
  it("is the recording when the pieces cover it end to end", () => {
    expect(wholeRecordingOf([piece(null, 300), piece(300, 800), piece(800, null)])).toBe(URL_A)
    expect(wholeRecordingOf([piece(0, 300), piece(300, 1200)])).toBe(URL_A)
  })
  it("is nothing when a piece was trimmed, or the pieces are of different recordings", () => {
    expect(wholeRecordingOf([piece(100, 300), piece(300, null)])).toBeNull()
    expect(wholeRecordingOf([piece(null, 300), piece(400, null)])).toBeNull()
    expect(wholeRecordingOf([piece(null, 300), piece(300, 1000)])).toBeNull()
    expect(wholeRecordingOf([piece(null, 300), piece(300, null, "frontier-audio://other.wav")])).toBeNull()
  })
})

describe("joinTakePieces", () => {
  const args = { session, projectId: "p1", fileId: "f1", cellId: "c1", slot: "recording", targetLang: "za", username: "dev" }

  it("pieces that tile their recording: a new take of the same bytes, nothing uploaded", async () => {
    const id = await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200, mimeType: "audio/wav" },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200, mimeType: "audio/wav" },
    ] })
    expect(uploads).toHaveLength(0)
    expect(attaches).toEqual([expect.objectContaining({ cellId: "c1", url: URL_A, audioId: id, slot: "recording", targetLang: "za", durationMs: 1200, label: undefined })])
    expect(id).toMatch(/^audio-c1-\d+-\w+\.wav$/)
    expect(id).not.toBe("a.wav")
  })

  // Sam, Oct 29 (question 7): the joined take is named "Take N", as the
  // recorder names takes. The caller works N out (nextTakeLabel); both ways of
  // joining store it on the new take.
  it("the joined take carries the name it is given, on both ways of joining", async () => {
    await joinTakePieces({ ...args, label: "Take 3", pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    await joinTakePieces({ ...args, label: "Take 4", pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    expect(attaches.map((a) => a.label)).toEqual(["Take 3", "Take 4"])
  })

  it("trimmed pieces: their audible parts, joined in order and uploaded as one WAV", async () => {
    await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    // 200 ms + 400 ms of a 1 kHz "recording".
    expect(uploads).toEqual([expect.objectContaining({ ext: "wav", size: 600 })])
    expect(attaches).toEqual([expect.objectContaining({ durationMs: 600, mimeType: "audio/wav", url: expect.stringMatching(/^frontier-audio:\/\/audio-c1-/) })])
  })
})
