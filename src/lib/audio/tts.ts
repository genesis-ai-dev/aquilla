// Main-thread orchestrator for TTS. Kokoro stays browser-local through the
// worker path; Gemini uses BYOK REST and returns raw PCM that we wrap in WAV.

import { useSyncExternalStore } from "react"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { requestAiModelConsent, KOKORO_MODEL, AiModelConsentDeniedError } from "./ai-consent"
import type { ResultMessage, ErrorMessage, ProgressMessage, SynthRequest } from "./kokoro-worker"
import { synthesizeGeminiTtsToWavBlob, type GeminiTtsContext } from "./gemini-tts"
import { floatPcmToWavBlob } from "./wav"
import { resolveVoice } from "./voices"
import { resolveApiKey } from "@/lib/store/user-api-keys"

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
  /** Resolved voice (from the project library + per-cell voiceId). */
  voice: Voice
  /** Project-level provider override; defaults to voice.provider. */
  projectProvider?: ProjectTtsSettings["provider"]
  apiKey?: string
  speed?: number
  geminiContext?: GeminiTtsContext
  onProgress?: (p: { loaded: number; total: number; file: string; status: string }) => void
}

export async function synthesizeToWavBlob(
  text: string,
  opts: SynthOptions,
): Promise<Blob> {
  const provider = opts.projectProvider ?? opts.voice.provider ?? "gemini"

  if (provider === "gemini") {
    opts.onProgress?.({ loaded: 0, total: 0, file: "Gemini TTS", status: "ready" })
    return synthesizeGeminiTtsToWavBlob({
      text,
      apiKey: opts.apiKey ?? "",
      voice: opts.voice,
      context: opts.geminiContext,
    })
  }

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
      type: "synth", requestId, text, voice: opts.voice.voiceName, speed: opts.speed,
    }
    worker.postMessage(req)
  })
  return pcmToWavBlob(result.pcm, result.sampleRate)
}

/** Convenience: resolve voice from project + cell, then synth. */
export async function synthesizeForCell(
  text: string,
  args: {
    projectTtsSettings?: ProjectTtsSettings
    cellVoiceId?: string
    speed?: number
    geminiContext?: GeminiTtsContext
    onProgress?: SynthOptions["onProgress"]
  },
): Promise<Blob> {
  const voice = resolveVoice(args.projectTtsSettings, args.cellVoiceId)
  return synthesizeToWavBlob(text, {
    voice,
    projectProvider: args.projectTtsSettings?.provider,
    apiKey: resolveApiKey("gemini-tts", args.projectTtsSettings?.apiKey),
    speed: args.speed,
    geminiContext: args.geminiContext,
    onProgress: args.onProgress,
  })
}

export function pcmToWavBlob(pcm: Float32Array, sampleRate: number): Blob {
  return floatPcmToWavBlob(pcm, sampleRate)
}
