// Main-thread orchestrator for TTS. Kokoro stays browser-local through the
// worker path; Gemini uses BYOK REST and returns raw PCM that we wrap in WAV.

import { useSyncExternalStore } from "react"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { requestAiModelConsent, KOKORO_MODEL, MMS_MODEL, AiModelConsentDeniedError } from "./ai-consent"
import type { ResultMessage, ErrorMessage, ProgressMessage, SynthRequest } from "./kokoro-worker"
import type {
  ResultMessage as MmsResultMessage,
  ErrorMessage as MmsErrorMessage,
  ProgressMessage as MmsProgressMessage,
  SynthRequest as MmsSynthRequest,
} from "./mms-worker"
import { synthesizeGeminiTtsToWavBlob, type GeminiTtsContext } from "./gemini-tts"
import { floatPcmToWavBlob } from "./wav"
import { resolveVoice } from "./voices"
import { resolveApiKey } from "@/lib/store/user-api-keys"
import { noteModelDownloading, noteModelDownloadSettled } from "./prefetch"
import {
  normalizeVoiceForProvider,
  resolveTtsProvider,
} from "./tts-providers"

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

export function ttsStatusKey(cellId: string): string {
  return `synth:${cellId}`
}

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

/** A6: Returns true if any cell has a Gemini-key error in its TTS status.
 *  Used by VoiceLibraryPanel to show "Key invalid" when a key is present but
 *  synthesis has failed due to a bad key, vs "Key needed" when no key at all. */
export function useAnyGeminiKeyError(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      for (const s of status.values()) {
        if (s.kind !== "error") continue
        const m = s.message.toLowerCase()
        if (
          m.includes("api key") || m.includes("api_key") || m.includes("apikey") ||
          (m.includes("gemini") && m.includes("key"))
        ) return true
      }
      return false
    },
    () => false,
  )
}

let workerPromise: Promise<Worker> | null = null
let mmsWorkerPromise: Promise<Worker> | null = null
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

async function getMmsWorker(): Promise<Worker> {
  if (mmsWorkerPromise) return mmsWorkerPromise
  const p = (async () => {
    const mod = await import("./mms-worker?worker")
    const Ctor = mod.default as new () => Worker
    return new Ctor()
  })()
  mmsWorkerPromise = p
  p.catch(() => { if (mmsWorkerPromise === p) mmsWorkerPromise = null })
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
  const cleanText = text.trim()
  if (!cleanText) throw new Error("No text to synthesize.")

  const provider = opts.projectProvider ?? opts.voice.provider ?? "gemini"
  const voice = normalizeVoiceForProvider(opts.voice, provider, {
    targetLanguage: opts.geminiContext?.targetLanguage,
  })

  if (provider === "gemini") {
    opts.onProgress?.({ loaded: 0, total: 0, file: "Gemini TTS", status: "ready" })
    return synthesizeGeminiTtsToWavBlob({
      text: cleanText,
      apiKey: opts.apiKey ?? "",
      voice,
      context: opts.geminiContext,
    })
  }

  if (provider === "mms") {
    const consented = await requestAiModelConsent(MMS_MODEL)
    if (!consented) throw new AiModelConsentDeniedError(MMS_MODEL.id)
    const lang = (voice.voiceName ?? "").trim()
    if (!lang) throw new Error("Set a supported MMS language code (e.g. eng, fra, spa) on this voice before generating.")
    const worker = await getMmsWorker()
    const requestId = `mms-${++workerSeq}`
    const result = await new Promise<MmsResultMessage>((resolve, reject) => {
      const onMessage = (event: MessageEvent<MmsResultMessage | MmsErrorMessage | MmsProgressMessage>) => {
        const m = event.data
        if (m.requestId !== requestId) return
        if (m.type === "progress") {
          opts.onProgress?.({ loaded: m.loaded, total: m.total, file: m.file, status: m.status })
          noteModelDownloading("mms", m)
          return
        }
        worker.removeEventListener("message", onMessage)
        if (m.type === "result") { noteModelDownloadSettled("mms", true); resolve(m) }
        else { noteModelDownloadSettled("mms", false); reject(new Error(friendlyMmsError(m.message))) }
      }
      worker.addEventListener("message", onMessage)
      const req: MmsSynthRequest = { type: "synth", requestId, lang, text: cleanText }
      worker.postMessage(req)
    })
    return pcmToWavBlob(result.pcm, result.sampleRate)
  }

  // Kokoro fallback (default for any unknown provider).
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
        noteModelDownloading("kokoro", m)
        return
      }
      worker.removeEventListener("message", onMessage)
      if (m.type === "result") { noteModelDownloadSettled("kokoro", true); resolve(m) }
      else { noteModelDownloadSettled("kokoro", false); reject(new Error(m.message)) }
    }
    worker.addEventListener("message", onMessage)
    const req: SynthRequest = {
      type: "synth", requestId, text: cleanText, voice: voice.voiceName, speed: opts.speed,
    }
    worker.postMessage(req)
  })
  return pcmToWavBlob(result.pcm, result.sampleRate)
}

function friendlyMmsError(raw: string): string {
  const r = raw.toLowerCase()
  if (r.includes("unauthorized access") || r.includes("401") || r.includes("403")) {
    return "Model host rejected the MMS download. Check that the R2 model bucket is public and CORS allows this app."
  }
  if (r.includes("tensor shape.size() must be >= 0") || r.includes("input_ids")) {
    return "MMS could not tokenize this text. Check that the cell text matches the selected MMS language."
  }
  return raw
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
    projectProvider: resolveTtsProvider(args.projectTtsSettings),
    apiKey: resolveApiKey("gemini-tts", args.projectTtsSettings?.apiKey),
    speed: args.speed,
    geminiContext: args.geminiContext,
    onProgress: args.onProgress,
  })
}

export function pcmToWavBlob(pcm: Float32Array, sampleRate: number): Blob {
  return floatPcmToWavBlob(pcm, sampleRate)
}
