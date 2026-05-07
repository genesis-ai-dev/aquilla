// Web Worker that runs Meta MMS-TTS in the browser using ONNX Runtime Web.
// Models come from the public Sherpa-ONNX MMS mirror, which already converted
// the Meta checkpoints to model.onnx + tokens.txt. Each language still downloads
// about 100-150 MB the first time and is cached by the browser Cache API.
//
// MMS doesn't take prompts, voice ids, or speed: the "voice" is the language
// model itself. The Voice editor hides those fields when provider === "mms".

/// <reference lib="webworker" />
import { env, pipeline, type TextToAudioPipeline } from "@huggingface/transformers"
import * as ort from "onnxruntime-web/wasm"
import {
  MMS_MODEL_REMOTE_HOST,
  MMS_MODEL_REMOTE_PATH_TEMPLATE,
  MMS_RUNTIME,
  MMS_SHERPA_CACHE_KEY,
  mmsModelIdForLanguage,
  mmsSherpaModelUrlsForLanguage,
  supportedMmsLanguageSummary,
} from "./mms-languages"

export interface SynthRequest {
  type: "synth"
  requestId: string
  /** Supported MMS language code, e.g. "eng", "fra", "spa". */
  lang: string
  text: string
}

export interface WarmupRequest {
  type: "warmup"
  requestId: string
  lang: string
}

export interface ProgressMessage {
  type: "progress"
  requestId: string
  loaded: number
  total: number
  file: string
  status: string
}

export interface ResultMessage {
  type: "result"
  requestId: string
  pcm: Float32Array
  sampleRate: number
}

export interface WarmedMessage {
  type: "warmed"
  requestId: string
}

export interface ErrorMessage {
  type: "error"
  requestId: string
  message: string
}

interface MmsSession {
  session: ort.InferenceSession
  tokens: Map<string, number>
}

if (MMS_RUNTIME === "transformers" && MMS_MODEL_REMOTE_HOST) {
  env.remoteHost = MMS_MODEL_REMOTE_HOST
  env.remotePathTemplate = MMS_MODEL_REMOTE_PATH_TEMPLATE
}

const MMS_SAMPLE_RATE = 16_000
const BLANK_TOKEN_ID = 0

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false

const sessions = new Map<string, Promise<MmsSession>>()
const transformerPipelines = new Map<string, Promise<TextToAudioPipeline>>()

function postProgress(requestId: string, file: string, loaded: number, total: number, status: string): void {
  const msg: ProgressMessage = { type: "progress", requestId, loaded, total, file, status }
  ;(self as unknown as Worker).postMessage(msg)
}

function postError(requestId: string, error: unknown): void {
  const msg: ErrorMessage = {
    type: "error",
    requestId,
    message: error instanceof Error ? error.message : String(error),
  }
  ;(self as unknown as Worker).postMessage(msg)
}

function modelUrlsFor(lang: string): { model: string; tokens: string } {
  const urls = mmsSherpaModelUrlsForLanguage(lang)
  if (!urls) {
    throw new Error(
      `MMS local TTS is not available for "${lang}". Available browser models: ${supportedMmsLanguageSummary()}.`,
    )
  }
  return urls
}

function transformersModelIdFor(lang: string): string {
  const modelId = mmsModelIdForLanguage(lang)
  if (!modelId) {
    throw new Error(
      `MMS local TTS is not available for "${lang}". Available browser models: ${supportedMmsLanguageSummary()}.`,
    )
  }
  return modelId
}

async function getTransformersPipeline(lang: string, requestId: string): Promise<TextToAudioPipeline> {
  const key = lang.trim().toLowerCase()
  const existing = transformerPipelines.get(key)
  if (existing) return existing

  const progressCb = (info: unknown) => {
    const i = info as { status?: string; file?: string; loaded?: number; total?: number }
    postProgress(requestId, i.file ?? "", i.loaded ?? 0, i.total ?? 0, i.status ?? "")
  }

  const created = (async () => {
    return (await pipeline("text-to-speech", transformersModelIdFor(key), {
      dtype: "fp32",
      progress_callback: progressCb,
    } as never)) as TextToAudioPipeline
  })()
  transformerPipelines.set(key, created)
  created.catch(() => { transformerPipelines.delete(key) })
  return created
}

async function readCached(url: string): Promise<Uint8Array | null> {
  if (typeof caches === "undefined") return null
  const cache = await caches.open(MMS_SHERPA_CACHE_KEY)
  const cached = await cache.match(url)
  if (!cached) return null
  return new Uint8Array(await cached.arrayBuffer())
}

async function writeCached(url: string, bytes: Uint8Array, contentType: string | null): Promise<void> {
  if (typeof caches === "undefined") return
  const cache = await caches.open(MMS_SHERPA_CACHE_KEY)
  const headers = contentType ? { "content-type": contentType } : undefined
  await cache.put(url, new Response(bytes.slice(), { headers }))
}

async function fetchBytes(url: string, requestId: string, file: string): Promise<Uint8Array> {
  const cached = await readCached(url)
  if (cached) {
    postProgress(requestId, file, cached.byteLength, cached.byteLength, "cached")
    return cached
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`MMS model download failed for ${file}: ${response.status} ${response.statusText}`)

  const total = Number(response.headers.get("content-length") || 0)
  const contentType = response.headers.get("content-type")
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    postProgress(requestId, file, bytes.byteLength, total || bytes.byteLength, "downloaded")
    await writeCached(url, bytes, contentType)
    return bytes
  }

  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loaded += value.byteLength
    postProgress(requestId, file, loaded, total, "downloading")
  }

  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  await writeCached(url, bytes, contentType)
  postProgress(requestId, file, loaded, total || loaded, "downloaded")
  return bytes
}

function parseTokens(text: string): Map<string, number> {
  const tokens = new Map<string, number>()
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue
    const match = rawLine.match(/^(.*)\s+(\d+)$/)
    if (!match) continue
    tokens.set(match[1], Number(match[2]))
  }
  if (tokens.size === 0) throw new Error("MMS tokens.txt did not contain any tokens.")
  return tokens
}

function normalizeChar(ch: string): string {
  if (/\s/.test(ch)) return " "
  if (ch === "’" || ch === "`" || ch === "´") return "'"
  if (ch === "—") return "–"
  return ch
}

function tokenize(text: string, tokens: Map<string, number>): number[] {
  const ids: number[] = []
  for (const raw of text) {
    const ch = normalizeChar(raw)
    const id = tokens.get(ch) ?? tokens.get(ch.toLowerCase())
    if (id === undefined) continue
    ids.push(id)
  }
  if (ids.length === 0) {
    throw new Error("MMS could not tokenize this text. Check that the cell text matches the selected MMS language.")
  }

  const withBlanks: number[] = [BLANK_TOKEN_ID]
  for (const id of ids) withBlanks.push(id, BLANK_TOKEN_ID)
  return withBlanks
}

async function getSession(lang: string, requestId: string): Promise<MmsSession> {
  const key = lang.trim().toLowerCase()
  const existing = sessions.get(key)
  if (existing) return existing

  const created = (async () => {
    const urls = modelUrlsFor(key)
    const tokensBytes = await fetchBytes(urls.tokens, requestId, `${key}/tokens.txt`)
    const modelBytes = await fetchBytes(urls.model, requestId, `${key}/model.onnx`)
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    })
    return {
      session,
      tokens: parseTokens(new TextDecoder().decode(tokensBytes)),
    }
  })()

  sessions.set(key, created)
  created.catch(() => { sessions.delete(key) })
  return created
}

async function synthesize(msg: SynthRequest): Promise<ResultMessage> {
  const text = msg.text.trim()
  if (!text) throw new Error("No text to synthesize.")

  if (MMS_RUNTIME === "transformers") {
    const tts = await getTransformersPipeline(msg.lang, msg.requestId)
    const result = (await tts(text)) as { audio: Float32Array; sampling_rate: number }
    return {
      type: "result",
      requestId: msg.requestId,
      pcm: result.audio,
      sampleRate: result.sampling_rate,
    }
  }

  const { session, tokens } = await getSession(msg.lang, msg.requestId)
  const ids = tokenize(text, tokens)
  const outputs = await session.run({
    x: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    x_length: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    noise_scale: new ort.Tensor("float32", Float32Array.from([0.667]), [1]),
    length_scale: new ort.Tensor("float32", Float32Array.from([1.0]), [1]),
    noise_scale_w: new ort.Tensor("float32", Float32Array.from([0.8]), [1]),
  })

  const data = outputs.y.data
  const pcm = data instanceof Float32Array ? data : Float32Array.from(data as Iterable<number>)
  return {
    type: "result",
    requestId: msg.requestId,
    pcm,
    sampleRate: MMS_SAMPLE_RATE,
  }
}

type IncomingMessage = SynthRequest | WarmupRequest

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (msg.type === "warmup") {
    try {
      if (MMS_RUNTIME === "transformers") await getTransformersPipeline(msg.lang, msg.requestId)
      else await getSession(msg.lang, msg.requestId)
      const out: WarmedMessage = { type: "warmed", requestId: msg.requestId }
      ;(self as unknown as Worker).postMessage(out)
    } catch (e) {
      postError(msg.requestId, e)
    }
    return
  }

  if (msg.type !== "synth") return
  try {
    const out = await synthesize(msg)
    ;(self as unknown as Worker).postMessage(out, [out.pcm.buffer])
  } catch (e) {
    postError(msg.requestId, e)
  }
})
