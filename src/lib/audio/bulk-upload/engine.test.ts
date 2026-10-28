import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const uploads: Array<{ fileId: string; audioId: string; ext: string; size: number }> = []
const attaches: Array<Record<string, unknown>> = []
const cuts: Array<Record<string, unknown>> = []
let uploadFailures: Array<Error> = []

vi.mock("@/lib/audio/upload", async (orig) => {
  const real = await orig<typeof import("@/lib/audio/upload")>()
  return {
    ...real,
    uploadCellAudio: vi.fn(async (args: { fileId: string; audioId: string; ext: string; blob: Blob }) => {
      const fail = uploadFailures.shift()
      if (fail) throw fail
      uploads.push({ fileId: args.fileId, audioId: args.audioId, ext: args.ext, size: args.blob.size })
      return { audioId: args.audioId, ext: args.ext, url: real.buildFrontierAudioUrl(args.audioId, args.ext), sizeBytes: args.blob.size }
    }),
  }
})
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => { attaches.push(input); return `ev-${attaches.length}` }),
  emitCellAudioCut: vi.fn(async (input: Record<string, unknown>) => { cuts.push(input); return `cut-${cuts.length}` }),
}))
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 2403.6) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: vi.fn(),
  notifyAudioAttachmentsChanged: vi.fn(),
}))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "token" }))
vi.mock("@/lib/audio/decode-mono", () => ({
  TARGET_RATE: 48000,
  // Each part decodes to its byte length in ms of silence.
  decodeToMono48k: vi.fn(async (bytes: Uint8Array) => new Float32Array(bytes.length * 48)),
  concatPcm: (clips: Float32Array[]) => {
    const out = new Float32Array(clips.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of clips) { out.set(c, at); at += c.length }
    return out
  },
}))

import {
  __resetBulkUploadForTests,
  cancelBulkUpload,
  getBulkUploadState,
  retryFailedBulkUploads,
  startBulkUpload,
  type BulkUploadRequest,
} from "./engine"
import type { UploadJob } from "./match"

const session = { jwt: "jwt", username: "dev", createdAt: "" } as unknown as BulkUploadRequest["session"]

function file(name: string, bytes = 1000): File {
  return new File([new Uint8Array(bytes)], name, { type: "audio/wav" })
}

function request(jobs: UploadJob[], files: File[], extra: Partial<BulkUploadRequest> = {}): BulkUploadRequest {
  return { projectId: "p1", session, username: "dev", targetLang: "za", jobs, files, targetLabel: () => "Genesis 1:1", ...extra }
}

beforeEach(() => {
  uploads.length = 0
  attaches.length = 0
  cuts.length = 0
  uploadFailures = []
  __resetBulkUploadForTests()
})
afterEach(() => vi.useRealTimers())

describe("bulk upload engine", () => {
  it("one file onto one line is the one-file upload's take: cell-seeded id, no label, the lane, whole-ms duration", async () => {
    await startBulkUpload(request([{ kind: "single", fileId: "f1", cellId: "GEN 1:1", files: [0] }], [file("Genesis 1-1.wav")]))
    expect(uploads).toHaveLength(1)
    expect(uploads[0].audioId).toMatch(/^audio-GEN_1_1-\d+-\w+$/)
    expect(attaches).toHaveLength(1)
    const a = attaches[0]
    expect(a).toMatchObject({ projectId: "p1", fileId: "f1", cellId: "GEN 1:1", slot: "recording", mimeType: "audio/wav", targetLang: "za", audioOrigin: "attach", author: "dev" })
    expect(a.audioId).toBe(`${uploads[0].audioId}.wav`)
    expect(a.label).toBeUndefined()
    expect(getBulkUploadState()).toMatchObject({ total: 1, done: 1, failed: [], finished: true })
  })

  it("a range is one object, and a take of it on every line it covers, each with its own id", async () => {
    await startBulkUpload(request([{ kind: "range", fileId: "f1", cellIds: ["c1", "c2", "c3"], files: [0] }], [file("Genesis 1-1-3.wav")]))
    expect(uploads).toHaveLength(1)
    expect(attaches.map((a) => a.cellId)).toEqual(["c1", "c2", "c3"])
    const urls = new Set(attaches.map((a) => a.url))
    expect(urls.size).toBe(1)
    expect(attaches[0].audioId).toBe(`${uploads[0].audioId}.wav`)
    expect((attaches[1].audioId as string)).toMatch(/^audio-c2-/)
    expect((attaches[2].audioId as string)).toMatch(/^audio-c3-/)
    expect(new Set(attaches.map((a) => a.audioId)).size).toBe(3)
  })

  it("the parts of a verse are joined in order, uploaded once, and cut at each join", async () => {
    // 300, 500 and 400 bytes decode to 300, 500 and 400 ms.
    await startBulkUpload(request([{ kind: "pieces", fileId: "f1", cellId: "c1", files: [0, 1, 2] }], [file("a.wav", 300), file("b.wav", 500), file("c.wav", 400)]))
    expect(uploads).toHaveLength(1)
    expect(uploads[0].ext).toBe("wav")
    expect(attaches).toHaveLength(1)
    expect(attaches[0]).toMatchObject({ durationMs: 1200, mimeType: "audio/wav" })
    expect(cuts.map((c) => c.atMs)).toEqual([300, 800])
    // The first cut is on the take itself; the second on the piece the first made.
    expect(cuts[0].audioId).toBe(attaches[0].audioId)
    expect(cuts[1].audioId).toBe(cuts[0].newAudioId)
    expect(getBulkUploadState()).toMatchObject({ total: 3, done: 3 })
  })

  it("numbered takes of one line upload one after another, so the last plays", async () => {
    await startBulkUpload(request([{ kind: "single", fileId: "f1", cellId: "c1", files: [1, 0] }], [file("take 2.wav", 222), file("take 1.wav", 111)]))
    expect(uploads.map((u) => u.size)).toEqual([111, 222])
  })

  it("retries a dropped connection, and lists a file that still fails with its reason", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    uploadFailures = [new TypeError("Failed to fetch")]
    const run = startBulkUpload(request([{ kind: "single", fileId: "f1", cellId: "c1", files: [0] }], [file("one.wav")]))
    await vi.advanceTimersByTimeAsync(3000)
    await run
    expect(uploads).toHaveLength(1)

    __resetBulkUploadForTests()
    uploads.length = 0
    uploadFailures = [new Error("audio upload failed (403): forbidden")]
    await startBulkUpload(request([{ kind: "single", fileId: "f1", cellId: "c1", files: [0] }], [file("two.wav")], { targetLabel: () => "Genesis 1:2" }))
    expect(getBulkUploadState()?.failed).toEqual([
      { index: 0, name: "two.wav", target: "Genesis 1:2", code: "other", message: "audio upload failed (403): forbidden" },
    ])
    // "Try them again" runs only the failures.
    await retryFailedBulkUploads()
    expect(uploads).toHaveLength(1)
    expect(getBulkUploadState()).toMatchObject({ total: 1, done: 1, failed: [] })
  })

  it("waits while offline, then carries on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    const run = startBulkUpload(request([{ kind: "single", fileId: "f1", cellId: "c1", files: [0] }], [file("one.wav")]))
    await vi.advanceTimersByTimeAsync(100)
    expect(getBulkUploadState()?.waitingForConnection).toBe(true)
    expect(uploads).toHaveLength(0)
    online.mockReturnValue(true)
    window.dispatchEvent(new Event("online"))
    await run
    expect(uploads).toHaveLength(1)
    expect(getBulkUploadState()).toMatchObject({ waitingForConnection: false, done: 1 })
    online.mockRestore()
  })

  it("stopping keeps what landed and counts what never started", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    const jobs: UploadJob[] = Array.from({ length: 10 }, (_, i) => ({ kind: "single", fileId: "f1", cellId: `c${i}`, files: [i] }))
    const run = startBulkUpload(request(jobs, jobs.map((_, i) => file(`${i}.wav`))))
    await vi.advanceTimersByTimeAsync(100)
    cancelBulkUpload()
    await run
    online.mockRestore()
    expect(uploads).toHaveLength(0)
    expect(getBulkUploadState()).toMatchObject({ cancelled: true, finished: true, done: 0, notStarted: 10 })
  })
})
