// Main-thread orchestrator for in-browser Kokoro TTS. Encodes the
// worker-returned Float32 PCM into a 16-bit WAV blob so it can be played by
// any HTMLAudioElement without further decoding.

import { useSyncExternalStore } from "react"
import { requestAiModelConsent, KOKORO_MODEL, AiModelConsentDeniedError } from "./ai-consent"
import type { ResultMessage, ErrorMessage, ProgressMessage, SynthRequest } from "./kokoro-worker"

export type TtsStatus =
  | { kind: "idle" }
  | { kind: "loading"; loaded: number; total: number; file: string }
  | { kind: "synthesizing" }
  | { kind: "playing" }
  | { kind: "error"; message: string }

const IDLE: TtsStatus = { kind: "idle" }
const status = new Map<string, TtsStatus>()
const listeners = new Set<() => void>()

function notify() { for (const l of listeners) l() }

export function setTtsStatus(key: string, s: TtsStatus): void {
  status.set(key, s)
  notify()
}

export function getTtsStatus(key: string): TtsStatus {
  return status.get(key) ?? IDLE
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useTtsStatus(key: string | undefined): TtsStatus {
  return useSyncExternalStore(
    subscribe,
    () => (key ? getTtsStatus(key) : IDLE),
    () => IDLE,
  )
}

let workerPromise: Promise<Worker> | null = null
let workerSeq = 0

async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise
  // Clear on rejection so retries can re-attempt — see notes in transcribe.ts.
  const p = (async () => {
    const mod = await import("./kokoro-worker?worker")
    const Ctor = mod.default as new () => Worker
    return new Ctor()
  })()
  workerPromise = p
  p.catch(() => { if (workerPromise === p) workerPromise = null })
  return p
}

export interface SynthOptions {
  voice?: string
  speed?: number
  onProgress?: (p: { loaded: number; total: number; file: string; status: string }) => void
}

export async function synthesizeToWavBlob(
  text: string,
  opts: SynthOptions = {},
): Promise<Blob> {
  const consented = await requestAiModelConsent(KOKORO_MODEL)
  if (!consented) throw new AiModelConsentDeniedError(KOKORO_MODEL.id)
  const worker = await getWorker()
  const requestId = `tts-${++workerSeq}`
  const result = await new Promise<ResultMessage>((resolve, reject) => {
    const onMessage = (event: MessageEvent<ResultMessage | ErrorMessage | ProgressMessage>) => {
      const m = event.data
      if (m.requestId !== requestId) return
      if (m.type === "progress") {
        opts.onProgress?.({ loaded: m.loaded, total: m.total, file: m.file, status: m.status })
        return
      }
      worker.removeEventListener("message", onMessage)
      if (m.type === "result") resolve(m)
      else reject(new Error(m.message))
    }
    worker.addEventListener("message", onMessage)
    const req: SynthRequest = {
      type: "synth", requestId, text, voice: opts.voice, speed: opts.speed,
    }
    worker.postMessage(req)
  })
  return pcmToWavBlob(result.pcm, result.sampleRate)
}

/**
 * Encode mono Float32 PCM (range -1..1) as a 16-bit WAV blob. Tiny helper —
 * keeps the synthesis pipeline browser-only by avoiding a dedicated audio
 * encoder dependency.
 */
export function pcmToWavBlob(pcm: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length * bytesPerSample

  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, "WAVE")
  // fmt sub-chunk
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true)         // sub-chunk size
  view.setUint16(20, 1, true)          // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  // data sub-chunk
  writeString(view, 36, "data")
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
    offset += 2
  }

  return new Blob([buffer], { type: "audio/wav" })
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}
