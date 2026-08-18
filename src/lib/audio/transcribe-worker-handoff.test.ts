// AQU-929 regression guard: the PCM handed to the Whisper worker must be
// TRANSFERRED, not structured-cloned. A clone leaves a full copy of the clip
// alive on the main thread for the whole run — one of the drivers behind the
// ~2.6 GB peak measured during transcription — and it fails silently when it
// regresses (a missing transfer list still works, just at double the memory).
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  runWhisperOnPcm,
  releaseTranscriber,
  __setWhisperWorkerForTests,
} from "./transcribe"
import type { OutgoingMessage, TranscribeRequest } from "./whisper-worker"

/** Minimal Worker stand-in: records postMessage calls, can emit worker replies. */
function fakeWorker() {
  const listeners = new Set<(e: MessageEvent) => void>()
  const posted: Array<{ data: unknown; transfer?: Transferable[] }> = []
  return {
    posted,
    emit(msg: OutgoingMessage) {
      for (const fn of [...listeners]) fn({ data: msg } as MessageEvent)
    },
    lastRequest: () => posted[posted.length - 1]?.data as TranscribeRequest,
    addEventListener: (_type: string, fn: (e: MessageEvent) => void) => { listeners.add(fn) },
    removeEventListener: (_type: string, fn: (e: MessageEvent) => void) => { listeners.delete(fn) },
    postMessage: (data: unknown, transfer?: Transferable[]) => { posted.push({ data, transfer }) },
  }
}

type FakeWorker = ReturnType<typeof fakeWorker>

function install(): FakeWorker {
  const w = fakeWorker()
  __setWhisperWorkerForTests(w as unknown as Worker)
  return w
}

/** `runWhisperOnPcm` awaits the worker before posting — let that microtask land. */
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => { __setWhisperWorkerForTests(null) })

describe("runWhisperOnPcm", () => {
  it("transfers the PCM buffer to the worker instead of cloning it", async () => {
    const worker = install()
    const pcm = new Float32Array(16000)
    const buffer = pcm.buffer

    const pending = runWhisperOnPcm(pcm, { language: "en" })
    await flush()
    const req = worker.lastRequest()
    worker.emit({ type: "result", requestId: req.requestId, text: "hello", chunks: [] })

    await expect(pending).resolves.toEqual({ text: "hello", chunks: [] })
    expect(worker.posted).toHaveLength(1)
    expect(worker.posted[0].transfer).toEqual([buffer])
    expect(req.sampleRate).toBe(16000)
    expect(req.language).toBe("en")
  })

  it("forwards model-download progress and resolves with the transcript", async () => {
    const worker = install()
    const onProgress = vi.fn()

    const pending = runWhisperOnPcm(new Float32Array(8), { onProgress })
    await flush()
    const { requestId } = worker.lastRequest()
    worker.emit({ type: "progress", requestId, loaded: 5, total: 10, file: "model.onnx", status: "progress" })
    worker.emit({
      type: "result", requestId, text: "hi there",
      chunks: [{ text: "hi", start: 0, end: 1 }, { text: "there", start: 1, end: 2 }],
    })

    await expect(pending).resolves.toEqual({
      text: "hi there",
      chunks: [{ text: "hi", start: 0, end: 1 }, { text: "there", start: 1, end: 2 }],
    })
    expect(onProgress).toHaveBeenCalledWith({ status: "progress", file: "model.onnx", loaded: 5, total: 10 })
  })

  it("ignores messages belonging to another request", async () => {
    const worker = install()
    const pending = runWhisperOnPcm(new Float32Array(8))
    await flush()
    const { requestId } = worker.lastRequest()

    worker.emit({ type: "result", requestId: `${requestId}-other`, text: "wrong", chunks: [] })
    worker.emit({ type: "result", requestId, text: "right", chunks: [] })

    await expect(pending).resolves.toEqual({ text: "right", chunks: [] })
  })

  it("rejects when the worker reports an error", async () => {
    const worker = install()
    const pending = runWhisperOnPcm(new Float32Array(8))
    await flush()
    const { requestId } = worker.lastRequest()

    worker.emit({ type: "error", requestId, message: "onnx session failed" })

    await expect(pending).rejects.toThrow(/onnx session failed/)
  })
})

describe("releaseTranscriber", () => {
  it("asks the worker to drop its cached model session", async () => {
    const worker = install()

    await releaseTranscriber()

    expect(worker.posted).toEqual([{ data: { type: "release" }, transfer: undefined }])
  })

  it("is a no-op when no worker has been created", async () => {
    __setWhisperWorkerForTests(null)
    await expect(releaseTranscriber()).resolves.toBeUndefined()
  })
})
