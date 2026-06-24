// Web Worker that runs Whisper for word-level transcription. Lazily loads
// the pipeline on first use so the main bundle stays light. Reports progress
// during the (one-time) model download via a "progress" message.

/// <reference lib="webworker" />
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers"
import { throttleModelProgress } from "./progress-throttle"

env.allowLocalModels = false
env.allowRemoteModels = true

// ONNX Runtime spams [W:onnxruntime: ... VerifyEachNodeIsAssignedToAnEp] at
// error severity from native code on every WebGPU session. They're not
// actionable by us and just bury the actual transcription progress, so we
// filter them in this worker only.
const ORT_WARN_PREFIX = "[W:onnxruntime:"
const _origConsoleError = console.error.bind(console)
const _origConsoleWarn = console.warn.bind(console)
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes(ORT_WARN_PREFIX)) return
  _origConsoleError(...args)
}
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes(ORT_WARN_PREFIX)) return
  _origConsoleWarn(...args)
}

const DEFAULT_MODEL = "Xenova/whisper-base"

interface TranscribeRequest {
  type: "transcribe"
  requestId: string
  pcm: Float32Array
  sampleRate: number
  language?: string
  model?: string
}

interface WarmupRequest {
  type: "warmup"
  requestId: string
  model?: string
}

interface CancelRequest {
  type: "cancel"
}

type IncomingMessage = TranscribeRequest | WarmupRequest | CancelRequest

interface ProgressMessage {
  type: "progress"
  requestId: string
  loaded: number
  total: number
  file: string
  status: string
}

interface ResultMessage {
  type: "result"
  requestId: string
  text: string
  chunks: Array<{ text: string; start: number; end: number }>
}

interface WarmedMessage {
  type: "warmed"
  requestId: string
}

interface ErrorMessage {
  type: "error"
  requestId: string
  message: string
}

type OutgoingMessage = ProgressMessage | ResultMessage | ErrorMessage | WarmedMessage

let pipePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let activeModel: string | null = null

async function getPipe(model: string, requestId: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (pipePromise && activeModel === model) return pipePromise
  activeModel = model
  const progressCb = throttleModelProgress((info: unknown) => {
    const i = info as { status?: string; file?: string; loaded?: number; total?: number }
    const msg: ProgressMessage = {
      type: "progress",
      requestId,
      loaded: i.loaded ?? 0,
      total: i.total ?? 0,
      file: i.file ?? "",
      status: i.status ?? "",
    }
    ;(self as unknown as Worker).postMessage(msg)
  })
  // Prefer WebGPU; fall back to WASM if the GPU adapter fails (Safari, some
  // Firefox builds, machines without compatible discrete/integrated GPUs).
  pipePromise = (async () => {
    try {
      return await pipeline("automatic-speech-recognition", model, {
        device: "webgpu",
        progress_callback: progressCb,
      })
    } catch (e) {
      console.warn("[whisper-worker] WebGPU init failed, falling back to WASM:", e)
      return await pipeline("automatic-speech-recognition", model, {
        device: "wasm",
        progress_callback: progressCb,
      })
    }
  })().catch((err) => {
    pipePromise = null
    activeModel = null
    throw err
  }) as Promise<AutomaticSpeechRecognitionPipeline>
  return pipePromise
}

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (msg.type === "warmup") {
    try {
      await getPipe(msg.model ?? DEFAULT_MODEL, msg.requestId)
      const out: WarmedMessage = { type: "warmed", requestId: msg.requestId }
      ;(self as unknown as Worker).postMessage(out)
    } catch (e) {
      const out: ErrorMessage = {
        type: "error",
        requestId: msg.requestId,
        message: e instanceof Error ? e.message : String(e),
      }
      ;(self as unknown as Worker).postMessage(out)
    }
    return
  }
  if (msg.type !== "transcribe") return

  try {
    const pipe = await getPipe(msg.model ?? DEFAULT_MODEL, msg.requestId)
    // transformers.js wants Float32 mono PCM (it auto-resamples internally if
    // needed, but pre-resampling on the main thread saves CPU).
    const result = await pipe(msg.pcm as unknown as Float32Array, {
      return_timestamps: "word",
      language: msg.language,
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    const r = (Array.isArray(result) ? result[0] : result) as {
      text: string
      chunks?: Array<{ text: string; timestamp: [number | null, number | null] }>
    }
    const chunks = (r.chunks ?? [])
      .filter((c) => c.timestamp[0] != null && c.timestamp[1] != null)
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0]!, end: c.timestamp[1]! }))
      .filter((c) => c.text.length > 0)
    const out: ResultMessage = {
      type: "result",
      requestId: msg.requestId,
      text: r.text,
      chunks,
    }
    ;(self as unknown as Worker).postMessage(out)
  } catch (e) {
    const out: ErrorMessage = {
      type: "error",
      requestId: msg.requestId,
      message: e instanceof Error ? e.message : String(e),
    }
    ;(self as unknown as Worker).postMessage(out)
  }
})

export type { OutgoingMessage, IncomingMessage, TranscribeRequest, WarmupRequest, ProgressMessage, ResultMessage, ErrorMessage, WarmedMessage }
