import { beforeEach, describe, expect, it, vi } from "vitest"

const uploads: Array<{ audioId: string; ext: string; size: number }> = []
const attaches: Array<Record<string, unknown>> = []
const places: Array<Record<string, unknown>> = []

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
  emitCellAudioPlace: vi.fn(async (input: Record<string, unknown>) => { places.push(input); return "ev-place" }),
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({ injectOptimisticAudioAttachment: vi.fn(), notifyAudioAttachmentsChanged: vi.fn() }))
// AQU-2492 (review, Nov 9): the Undo steps a join records.
const steps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const pendings = vi.hoisted(() => [] as Array<Promise<boolean> | undefined>)
vi.mock("@/lib/history/history", async (orig) => ({
  ...(await orig<typeof import("@/lib/history/history")>()),
  recordStep: (step: Record<string, unknown>, _scope?: unknown, opts?: { pending?: Promise<boolean> }) => {
    steps.push(step)
    pendings.push(opts?.pending)
    return "step-id"
  },
}))
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
  places.length = 0
  uploads.length = 0
  attaches.length = 0
  steps.length = 0
  pendings.length = 0
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

  // AQU-2492 (review, Nov 9): joining left no Undo step, so ⌘Z after it undid
  // something else. Both ways of joining record the joined take as added:
  // Undo takes it away and the take in pieces plays again.
  it("records the joined take as an Undo step, on both ways of joining", async () => {
    const history = { selectedBefore: "a.wav" }
    const tiled = await joinTakePieces({ ...args, history, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    const uploaded = await joinTakePieces({ ...args, history, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    expect(steps).toEqual([tiled, uploaded].map((audioId) => expect.objectContaining({
      kind: "take.add",
      labelKey: "editor.history.stepJoinTake",
      fileId: "f1",
      data: { cellId: "c1", audioId, slot: "recording", selectedBefore: "a.wav" },
    })))
  })

  // AQU-2492 (review, Nov 9), finding 15: recorded when the join STARTS,
  // waiting on it — ⌘Z pressed while it decodes and uploads waits for it and
  // undoes the join, never an older step. A failed join leaves no step.
  it("records its step as it starts, before the upload, waiting on the join", async () => {
    const { uploadCellAudio } = await import("@/lib/audio/upload")
    let stepsAtUpload = -1
    vi.mocked(uploadCellAudio).mockImplementationOnce(async (a: { audioId: string; ext: string; blob: Blob }) => {
      stepsAtUpload = steps.length
      return { audioId: a.audioId, ext: a.ext, url: `frontier-audio://${a.audioId}.${a.ext}`, sizeBytes: a.blob.size }
    })
    const id = await joinTakePieces({ ...args, history: { selectedBefore: "a.wav" }, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })
    expect(stepsAtUpload).toBe(1)
    expect(steps[0]).toMatchObject({ kind: "take.add", data: { audioId: id } })
    expect(attaches[0]).toMatchObject({ audioId: id })
    expect(await pendings[0]).toBe(true)
  })

  it("a join that fails leaves its step to be dropped", async () => {
    const { uploadCellAudio } = await import("@/lib/audio/upload")
    vi.mocked(uploadCellAudio).mockRejectedValueOnce(new Error("audio upload failed (500)"))
    await expect(joinTakePieces({ ...args, history: { selectedBefore: "a.wav" }, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900 },
    ] })).rejects.toThrow(/upload failed/)
    expect(steps).toHaveLength(1)
    expect(await pendings[0]).toBe(false)
  })

  it("records nothing when no step is asked for", async () => {
    await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    expect(steps).toEqual([])
  })
})

// AQU-2491 (review, Nov 9): a line recorded before AQU-2491 holds the
// recorder's pre-roll as its place, and a take with no place of its own reads
// that one. A take recorded since has its own (-200, its pre-roll), and so do
// its pieces. The joined take is made from them, so it keeps that place, in
// both timings, instead of reading the line's and moving.
describe("joinTakePieces: the joined take keeps its pieces' place (AQU-2491)", () => {
  const args = { session, projectId: "p1", fileId: "f1", cellId: "c1", slot: "recording", targetLang: "za", username: "dev" }

  it("on both ways of joining, the joined take is placed where its first piece is", async () => {
    const a = await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200, targetOffsetMs: -200, recordingsOffsetMs: 40 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200, targetOffsetMs: -200, recordingsOffsetMs: 40 },
    ] })
    const b = await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: 100, trimEndMs: 300, targetOffsetMs: -200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 500, trimEndMs: 900, targetOffsetMs: -200 },
    ] })
    expect(places).toEqual([
      expect.objectContaining({ audioId: a, targetOffsetMs: -200, recordingsOffsetMs: 40, targetLang: "za" }),
      expect.objectContaining({ audioId: b, targetOffsetMs: -200, recordingsOffsetMs: null }),
    ])
  })

  it("pieces with no place of their own: nothing is placed, and the joined take reads the line's, as they do", async () => {
    await joinTakePieces({ ...args, pieces: [
      { audioId: "a.wav", url: URL_A, trimStartMs: null, trimEndMs: 300, durationMs: 1200 },
      { audioId: "b.wav", url: URL_A, trimStartMs: 300, trimEndMs: null, durationMs: 1200 },
    ] })
    expect(places).toEqual([])
  })
})
