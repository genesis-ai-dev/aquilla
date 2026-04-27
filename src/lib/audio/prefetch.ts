// Background prefetch for the heavy in-browser AI models. Drives both the
// onboarding "Download AI features" step and the floating progress chip.
//
// Internals: sends a "warmup" message to the lazy-loaded Whisper and Kokoro
// workers; they call their pipeline init (downloading model weights to the
// browser's Cache API) and post progress back. Subsequent transcribe / synth
// calls find the pipeline already warm and run instantly.

import { useSyncExternalStore } from "react"
import type {
  ProgressMessage as WhisperProgress,
  ErrorMessage as WhisperError,
  WarmedMessage as WhisperWarmed,
  WarmupRequest as WhisperWarmupRequest,
} from "./whisper-worker"
import type {
  ProgressMessage as KokoroProgress,
  ErrorMessage as KokoroError,
  WarmedMessage as KokoroWarmed,
  WarmupRequest as KokoroWarmupRequest,
} from "./kokoro-worker"

export type ModelId = "whisper" | "kokoro"

export type ModelPrefetchStatus =
  | { kind: "idle" }
  | { kind: "downloading"; loaded: number; total: number; file: string }
  | { kind: "ready" }
  | { kind: "error"; message: string }

const READY: ModelPrefetchStatus = { kind: "ready" }
const IDLE: ModelPrefetchStatus = { kind: "idle" }

const status = new Map<ModelId, ModelPrefetchStatus>()
const listeners = new Set<() => void>()

function notify() { for (const l of listeners) l() }

/** @internal — exposed for tests; do not use in app code. */
export const __testOnlySetStatus = (model: ModelId, s: ModelPrefetchStatus): void => setStatus(model, s)

function setStatus(model: ModelId, s: ModelPrefetchStatus): void {
  // Each model loads several files (model weights, tokenizer, config, voice
  // table, …). The pipeline reports progress per file, so naïvely forwarding
  // every event makes the bar reset to "starting…" between files. Prefer the
  // larger total when we're still downloading so the chip moves monotonically.
  if (s.kind === "downloading") {
    const prev = status.get(model)
    if (prev?.kind === "downloading" && prev.total > s.total) s = prev
    else if (prev?.kind === "downloading" && prev.total === s.total && prev.loaded > s.loaded) s = prev
  }
  status.set(model, s)
  notify()
}

export function getModelStatus(model: ModelId): ModelPrefetchStatus {
  return status.get(model) ?? IDLE
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useModelStatus(model: ModelId): ModelPrefetchStatus {
  return useSyncExternalStore(
    subscribe,
    () => getModelStatus(model),
    () => IDLE,
  )
}

function markReady(model: ModelId): void {
  setStatus(model, READY)
}

// transformers.js v3 stores downloaded weights in CacheStorage under this key
// (env.cacheKey default). Probing it is the most accurate way to know whether
// a model is locally available — survives across sessions and tabs without us
// having to maintain a parallel "isDownloaded" flag.
const TRANSFORMERS_CACHE_KEY = "transformers-cache"
const MODEL_REPOS: Record<ModelId, string> = {
  whisper: "Xenova/whisper-base",
  kokoro: "onnx-community/Kokoro-82M-v1.0-ONNX",
}

/**
 * Derive ready state from the browser cache. Sets each model to `ready` iff
 * any cached request URL references the model's HF repo. Safe to call
 * multiple times; later worker progress events for an in-flight download
 * win out via setStatus's monotonic guard.
 */
export async function hydratePrefetchStatus(): Promise<void> {
  if (typeof caches === "undefined") return
  try {
    const has = await caches.has(TRANSFORMERS_CACHE_KEY)
    if (!has) return
    const cache = await caches.open(TRANSFORMERS_CACHE_KEY)
    const keys = await cache.keys()
    const urls = keys.map((k) => k.url)
    for (const m of Object.keys(MODEL_REPOS) as ModelId[]) {
      if (status.get(m)?.kind === "downloading") continue
      if (urls.some((u) => u.includes(MODEL_REPOS[m]))) status.set(m, READY)
    }
    notify()
  } catch {
    /* ignore — cache probe is best-effort */
  }
}

export async function clearPrefetchStatus(model?: ModelId): Promise<void> {
  if (model) status.delete(model)
  else status.clear()
  notify()
  if (typeof caches === "undefined") return
  try {
    const has = await caches.has(TRANSFORMERS_CACHE_KEY)
    if (!has) return
    const cache = await caches.open(TRANSFORMERS_CACHE_KEY)
    const keys = await cache.keys()
    await Promise.all(
      keys.map((req) => {
        if (!model) return cache.delete(req)
        if (req.url.includes(MODEL_REPOS[model])) return cache.delete(req)
        return Promise.resolve(false)
      })
    )
  } catch {
    /* ignore */
  }
}

let whisperWorkerPromise: Promise<Worker> | null = null
let kokoroWorkerPromise: Promise<Worker> | null = null
let prefetchSeq = 0

async function getWhisperWorker(): Promise<Worker> {
  if (whisperWorkerPromise) return whisperWorkerPromise
  whisperWorkerPromise = (async () => {
    const mod = await import("./whisper-worker?worker")
    return new (mod.default as new () => Worker)()
  })()
  return whisperWorkerPromise
}
async function getKokoroWorker(): Promise<Worker> {
  if (kokoroWorkerPromise) return kokoroWorkerPromise
  kokoroWorkerPromise = (async () => {
    const mod = await import("./kokoro-worker?worker")
    return new (mod.default as new () => Worker)()
  })()
  return kokoroWorkerPromise
}

async function warmWhisper(): Promise<void> {
  if (getModelStatus("whisper").kind === "ready") return
  setStatus("whisper", { kind: "downloading", loaded: 0, total: 0, file: "" })
  const worker = await getWhisperWorker()
  const requestId = `warm-w-${++prefetchSeq}`
  await new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent<WhisperProgress | WhisperWarmed | WhisperError>) => {
      const m = event.data
      if (m.requestId !== requestId) return
      if (m.type === "progress") {
        setStatus("whisper", { kind: "downloading", loaded: m.loaded, total: m.total, file: m.file })
        return
      }
      worker.removeEventListener("message", onMessage)
      if (m.type === "warmed") { markReady("whisper"); resolve() }
      else { setStatus("whisper", { kind: "error", message: m.message }); reject(new Error(m.message)) }
    }
    worker.addEventListener("message", onMessage)
    const req: WhisperWarmupRequest = { type: "warmup", requestId }
    worker.postMessage(req)
  })
}

async function warmKokoro(): Promise<void> {
  if (getModelStatus("kokoro").kind === "ready") return
  setStatus("kokoro", { kind: "downloading", loaded: 0, total: 0, file: "" })
  const worker = await getKokoroWorker()
  const requestId = `warm-k-${++prefetchSeq}`
  await new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent<KokoroProgress | KokoroWarmed | KokoroError>) => {
      const m = event.data
      if (m.requestId !== requestId) return
      if (m.type === "progress") {
        setStatus("kokoro", { kind: "downloading", loaded: m.loaded, total: m.total, file: m.file })
        return
      }
      worker.removeEventListener("message", onMessage)
      if (m.type === "warmed") { markReady("kokoro"); resolve() }
      else { setStatus("kokoro", { kind: "error", message: m.message }); reject(new Error(m.message)) }
    }
    worker.addEventListener("message", onMessage)
    const req: KokoroWarmupRequest = { type: "warmup", requestId }
    worker.postMessage(req)
  })
}

export interface PrefetchOptions {
  models?: ModelId[]
}

/**
 * Trigger background download of the AI models. Resolves when all requested
 * models report ready (or rejects on first failure). Safe to call multiple
 * times — already-warm models short-circuit.
 *
 * NOTE: Does not gate on the user-consent dialog — callers should ask the
 * user first (e.g. via the onboarding step's explicit button). Once the model
 * is downloaded once, subsequent feature uses skip the consent prompt for
 * that model regardless.
 */
export async function prefetchAiModels(opts: PrefetchOptions = {}): Promise<void> {
  const models = opts.models ?? ["whisper", "kokoro"]
  const promises: Promise<void>[] = []
  if (models.includes("whisper")) promises.push(warmWhisper())
  if (models.includes("kokoro")) promises.push(warmKokoro())
  await Promise.all(promises)
}
