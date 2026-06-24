// Web Worker that runs Kokoro TTS for in-browser speech synthesis. Loads the
// 82M model on first use (~80MB, cached forever after) and reports progress.
// Returns 24kHz mono Float32 PCM that the main thread wraps into a Blob.

/// <reference lib="webworker" />
import { KokoroTTS } from "kokoro-js"
import { throttleModelProgress } from "./progress-throttle"

// Same ONNX warning suppression as whisper-worker — Kokoro's bundled ORT
// emits the same node-assignment warnings every synth call. Worker-scoped
// only, doesn't affect the main thread console.
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

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"
const DEFAULT_VOICE = "af_heart"

// HF CDN frequently omits Content-Length for LFS files, so transformers.js
// reports total=0 and the UI can't show a percentage. These are the actual
// byte sizes of the files we load (probed against the resolve URL). Keyed by
// path suffix so it survives whether the callback reports the bare filename
// or the full repo-relative path.
const KNOWN_SIZES: ReadonlyArray<readonly [string, number]> = [
  ["onnx/model_quantized.onnx", 92_361_116],
  ["voices/af_heart.bin", 522_240],
  ["tokenizer.json", 3_497],
  ["tokenizer_config.json", 113],
  ["config.json", 44],
]

function knownTotalFor(file: string): number {
  if (!file) return 0
  for (const [suffix, size] of KNOWN_SIZES) {
    if (file.endsWith(suffix)) return size
  }
  return 0
}

interface SynthRequest {
  type: "synth"
  requestId: string
  text: string
  voice?: string
  speed?: number
}

interface WarmupRequest {
  type: "warmup"
  requestId: string
}

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
  pcm: Float32Array
  sampleRate: number
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

let ttsPromise: Promise<KokoroTTS> | null = null

async function getTts(requestId: string): Promise<KokoroTTS> {
  if (ttsPromise) return ttsPromise
  const progressCb = throttleModelProgress((info: unknown) => {
    const i = info as { status?: string; file?: string; loaded?: number; total?: number }
    const file = i.file ?? ""
    const reportedTotal = i.total ?? 0
    const total = reportedTotal > 0 ? reportedTotal : knownTotalFor(file)
    const msg: ProgressMessage = {
      type: "progress",
      requestId,
      loaded: i.loaded ?? 0,
      total,
      file,
      status: i.status ?? "",
    }
    ;(self as unknown as Worker).postMessage(msg)
  })
  // Try WebGPU first; fall back to WASM if the GPU adapter isn't usable.
  ttsPromise = (async () => {
    try {
      return await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8", device: "webgpu", progress_callback: progressCb,
      } as never)
    } catch (e) {
      console.warn("[kokoro-worker] WebGPU init failed, falling back to WASM:", e)
      return await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8", device: "wasm", progress_callback: progressCb,
      } as never)
    }
  })().catch((err) => {
    ttsPromise = null
    throw err
  })
  return ttsPromise
}

type IncomingMessage = SynthRequest | WarmupRequest

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (msg.type === "warmup") {
    try {
      await getTts(msg.requestId)
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
  if (msg.type !== "synth") return
  try {
    const tts = await getTts(msg.requestId)
    const audio = await tts.generate(msg.text, {
      voice: (msg.voice ?? DEFAULT_VOICE) as never,
      speed: msg.speed ?? 1.0,
    } as never)
    const a = audio as unknown as { audio: Float32Array; sampling_rate: number }
    const out: ResultMessage = {
      type: "result",
      requestId: msg.requestId,
      pcm: a.audio,
      sampleRate: a.sampling_rate,
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

export type { ResultMessage, ErrorMessage, ProgressMessage, SynthRequest, WarmupRequest, WarmedMessage }
