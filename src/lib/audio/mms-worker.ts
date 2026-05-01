// Web Worker that runs Meta's MMS-TTS via transformers.js. Each supported
// language id loads its `Xenova/mms-tts-{lang}` repo (~100-150 MB the first
// time, HF-cached after) and synthesizes 16 kHz Float32 PCM. Multiple voices
// can share a language; we cache pipelines per language id.
//
// MMS doesn't take prompts, voice ids, or speed — it's a text-in / audio-out
// model whose "voice" is the language model itself. The Voice editor hides
// those fields when provider === "mms".

/// <reference lib="webworker" />
import { env, pipeline, type TextToAudioPipeline } from "@huggingface/transformers"
import {
  MMS_MODEL_REMOTE_HOST,
  MMS_MODEL_REMOTE_PATH_TEMPLATE,
  mmsModelIdForLanguage,
  supportedMmsLanguageSummary,
} from "./mms-languages"

if (MMS_MODEL_REMOTE_HOST) {
  env.remoteHost = MMS_MODEL_REMOTE_HOST
  env.remotePathTemplate = MMS_MODEL_REMOTE_PATH_TEMPLATE
}

interface SynthRequest {
  type: "synth"
  requestId: string
  /** Supported MMS language code, e.g. "eng", "fra", "spa". */
  lang: string
  text: string
}

interface WarmupRequest {
  type: "warmup"
  requestId: string
  lang: string
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

const pipelines = new Map<string, Promise<TextToAudioPipeline>>()

function modelIdFor(lang: string): string {
  const modelId = mmsModelIdForLanguage(lang)
  if (!modelId) {
    throw new Error(
      `MMS local TTS is not available for "${lang}". Available browser models: ${supportedMmsLanguageSummary()}.`,
    )
  }
  return modelId
}

async function getPipeline(lang: string, requestId: string): Promise<TextToAudioPipeline> {
  const key = lang.trim().toLowerCase()
  const existing = pipelines.get(key)
  if (existing) return existing

  const progressCb = (info: unknown) => {
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
  }

  const created = (async () => {
    return (await pipeline("text-to-speech", modelIdFor(key), {
      dtype: "fp32",
      progress_callback: progressCb,
    } as never)) as TextToAudioPipeline
  })()
  pipelines.set(key, created)
  created.catch(() => { pipelines.delete(key) })
  return created
}

type IncomingMessage = SynthRequest | WarmupRequest

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (msg.type === "warmup") {
    try {
      await getPipeline(msg.lang, msg.requestId)
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
    const text = msg.text.trim()
    if (!text) throw new Error("No text to synthesize.")
    const tts = await getPipeline(msg.lang, msg.requestId)
    const result = (await tts(text)) as { audio: Float32Array; sampling_rate: number }
    const out: ResultMessage = {
      type: "result",
      requestId: msg.requestId,
      pcm: result.audio,
      sampleRate: result.sampling_rate,
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
