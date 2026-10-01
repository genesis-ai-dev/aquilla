// AQU-1533 regression guard: the Whisper worker must pick its execution device
// BEFORE the first pipeline() call.
//
// transformers.js serialises web session creation with
// `webInitChain = webInitChain.then(load)`, so one rejected session leaves the
// chain rejected for the life of the worker (huggingface/transformers.js#1767).
// The worker used to try WebGPU and "fall back" to WASM in a catch; on a
// browser that exposes navigator.gpu but hands out no adapter (Chrome with
// graphics acceleration off, VMs) the WASM attempt re-threw the WebGPU error
// and local transcription was dead. `stickyPipeline` below reproduces that
// chain, so these tests fail on a worker that attempts WebGPU without an
// adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IncomingMessage, OutgoingMessage } from "./whisper-worker"

const transformers = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {
    allowLocalModels: true,
    allowRemoteModels: true,
    backends: { onnx: { webgpu: { powerPreference: "high-performance" } } },
  },
}))
vi.mock("@huggingface/transformers", () => transformers)

const NO_ADAPTER_ERROR =
  'no available backend found. ERR: [webgpu] Error: Failed to get GPU adapter. You may need to enable flag "--enable-unsafe-webgpu" if you are using Chrome.'

type Device = "webgpu" | "wasm"
interface PipelineOptions { device: Device }

/** The devices each pipeline() call asked for, in order. */
const requestedDevices = (): Device[] =>
  transformers.pipeline.mock.calls.map((call) => (call[2] as PipelineOptions).device)

/**
 * pipeline() as transformers.js behaves in a browser: session creation runs on
 * one module-level promise chain, and a rejection is never cleared from it.
 */
function stickyPipeline(webgpuSessionWorks: boolean) {
  let webInitChain: Promise<unknown> = Promise.resolve()
  return (_task: string, _model: string, opts: PipelineOptions) => {
    const load = () => {
      if (opts.device === "webgpu" && !webgpuSessionWorks) throw new Error(NO_ADAPTER_ERROR)
      const pipe = async () => ({ text: ` ran on ${opts.device}`, chunks: [{ text: " hi", timestamp: [0, 1] }] })
      return Object.assign(pipe, { dispose: vi.fn() })
    }
    return (webInitChain = webInitChain.then(load))
  }
}

function setGpu(gpu: { requestAdapter: (opts?: unknown) => Promise<unknown> } | undefined): void {
  Object.defineProperty(navigator, "gpu", { configurable: true, value: gpu })
}

const origConsole = { warn: console.warn, error: console.error, info: console.info }

/** Import a fresh worker module and return a handle that speaks its message protocol. */
async function startWorker() {
  vi.resetModules()
  let onMessage: ((event: MessageEvent<IncomingMessage>) => void) | undefined
  const addListener = vi.spyOn(self, "addEventListener").mockImplementation(((type: string, fn: typeof onMessage) => {
    if (type === "message") onMessage = fn
  }) as typeof self.addEventListener)
  const posted: OutgoingMessage[] = []
  vi.spyOn(self, "postMessage").mockImplementation(((msg: OutgoingMessage) => { posted.push(msg) }) as typeof self.postMessage)
  await import("./whisper-worker")
  addListener.mockRestore()
  if (!onMessage) throw new Error("whisper-worker registered no message listener")
  const handler = onMessage
  return {
    /** Send one request and resolve with the worker's terminal reply to it. */
    async request(msg: IncomingMessage & { requestId: string }): Promise<OutgoingMessage> {
      handler({ data: msg } as MessageEvent<IncomingMessage>)
      return vi.waitFor(() => {
        const reply = posted.find((m) => m.requestId === msg.requestId && m.type !== "progress")
        if (!reply) throw new Error(`no reply to ${msg.requestId} yet`)
        return reply
      })
    },
  }
}

beforeEach(() => {
  transformers.pipeline.mockReset()
  // The worker reports its device choice and fallbacks on the console.
  vi.spyOn(console, "info").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  // The worker wraps console.warn/error at import time; undo that per test.
  Object.assign(console, origConsole)
  Reflect.deleteProperty(navigator, "gpu")
})

describe("whisper-worker device selection", () => {
  it("warms up on WASM, never attempting WebGPU, when navigator.gpu has no adapter", async () => {
    transformers.pipeline.mockImplementation(stickyPipeline(false))
    setGpu({ requestAdapter: async () => null })
    const worker = await startWorker()

    await expect(worker.request({ type: "warmup", requestId: "w1" })).resolves.toEqual({ type: "warmed", requestId: "w1" })
    expect(requestedDevices()).toEqual(["wasm"])
  })

  it("transcribes on WASM from a cold worker when navigator.gpu has no adapter", async () => {
    transformers.pipeline.mockImplementation(stickyPipeline(false))
    setGpu({ requestAdapter: async () => null })
    const worker = await startWorker()

    const reply = await worker.request({ type: "transcribe", requestId: "t1", pcm: new Float32Array(16), sampleRate: 16000 })

    expect(reply).toEqual({ type: "result", requestId: "t1", text: " ran on wasm", chunks: [{ text: "hi", start: 0, end: 1 }] })
    expect(requestedDevices()).toEqual(["wasm"])
  })

  it("uses WebGPU when an adapter is available, asking for it the way ONNX Runtime will", async () => {
    transformers.pipeline.mockImplementation(stickyPipeline(true))
    const requestAdapter = vi.fn(async () => ({}))
    setGpu({ requestAdapter })
    const worker = await startWorker()

    await expect(worker.request({ type: "warmup", requestId: "w1" })).resolves.toEqual({ type: "warmed", requestId: "w1" })
    expect(requestedDevices()).toEqual(["webgpu"])
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance", forceFallbackAdapter: undefined })
  })

  it("uses WASM when the browser has no navigator.gpu at all", async () => {
    transformers.pipeline.mockImplementation(stickyPipeline(false))
    setGpu(undefined)
    const worker = await startWorker()

    await expect(worker.request({ type: "warmup", requestId: "w1" })).resolves.toEqual({ type: "warmed", requestId: "w1" })
    expect(requestedDevices()).toEqual(["wasm"])
  })

  it("uses WASM when the adapter request itself throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    transformers.pipeline.mockImplementation(stickyPipeline(false))
    setGpu({ requestAdapter: async () => { throw new Error("GPU process crashed") } })
    const worker = await startWorker()

    await expect(worker.request({ type: "warmup", requestId: "w1" })).resolves.toEqual({ type: "warmed", requestId: "w1" })
    expect(requestedDevices()).toEqual(["wasm"])
  })

  it("still falls back to WASM when a WebGPU load fails before session creation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const sticky = stickyPipeline(true)
    // Weights that will not download fail outside the session-creation chain.
    transformers.pipeline.mockImplementation(async (task: string, model: string, opts: PipelineOptions) => {
      if (opts.device === "webgpu") throw new Error("Could not locate file: onnx/encoder_model.onnx")
      return sticky(task, model, opts)
    })
    setGpu({ requestAdapter: async () => ({}) })
    const worker = await startWorker()

    await expect(worker.request({ type: "warmup", requestId: "w1" })).resolves.toEqual({ type: "warmed", requestId: "w1" })
    expect(requestedDevices()).toEqual(["webgpu", "wasm"])
  })
})
