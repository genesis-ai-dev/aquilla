// Page-local consent gate for the heavy in-browser AI models. The first
// time a user kicks off Whisper, Kokoro, or MMS we surface a dialog explaining
// the download size; subsequent uses (in this browser) skip it.
//
// Lives outside React so workers and orchestrators can call
// `requestAiModelConsent(...)` without prop-drilling, then a single
// AiModelConsentDialog mounted at the app root subscribes and renders.

import { useSyncExternalStore } from "react"

export class AiModelConsentDeniedError extends Error {
  readonly modelId: string
  constructor(modelId: string) {
    super(`User declined to download the ${modelId} model`)
    this.name = "AiModelConsentDeniedError"
    this.modelId = modelId
  }
}

export interface AiModelInfo {
  /** Stable id used for the localStorage key. */
  id: "whisper" | "kokoro" | "mms"
  /** Display name in the dialog. */
  label: string
  /** Approximate download size in MB (one-time). */
  sizeMb: number
  /** Short user-facing rationale. */
  rationale: string
}

interface PendingRequest {
  model: AiModelInfo
  resolve: (granted: boolean) => void
}

const KEY_PREFIX = "codex.aiConsent."
const ALL_FEATURES_KEY = "codex.aiConsent.all"
let pending: PendingRequest | null = null
const listeners = new Set<() => void>()

function notify() { for (const l of listeners) l() }

function hasStoredConsent(id: AiModelInfo["id"]): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    if (localStorage.getItem(ALL_FEATURES_KEY) === "1") return true
    return localStorage.getItem(KEY_PREFIX + id) === "1"
  } catch { return false }
}

function storeConsent(id: AiModelInfo["id"]): void {
  if (typeof localStorage === "undefined") return
  try { localStorage.setItem(KEY_PREFIX + id, "1") } catch { /* private mode */ }
}

/**
 * Stores the "all AI features" consent flag. Setting this skips the per-
 * model consent dialog for Whisper, Kokoro, and MMS. Used by the onboarding
 * "Enable AI voice & transcription" step which asks once for both.
 */
export function storeAllFeaturesConsent(): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(ALL_FEATURES_KEY, "1")
    // Also set per-model so legacy checks elsewhere stay consistent.
    localStorage.setItem(KEY_PREFIX + "whisper", "1")
    localStorage.setItem(KEY_PREFIX + "kokoro", "1")
    localStorage.setItem(KEY_PREFIX + "mms", "1")
  } catch { /* private mode */ }
}

export function hasAllFeaturesConsent(): boolean {
  if (typeof localStorage === "undefined") return false
  try { return localStorage.getItem(ALL_FEATURES_KEY) === "1" } catch { return false }
}

export function clearStoredConsent(id?: AiModelInfo["id"]): void {
  if (typeof localStorage === "undefined") return
  try {
    if (id) localStorage.removeItem(KEY_PREFIX + id)
    else {
      for (const k of Object.keys(localStorage)) if (k.startsWith(KEY_PREFIX)) localStorage.removeItem(k)
      localStorage.removeItem(ALL_FEATURES_KEY)
    }
  } catch { /* ignore */ }
}

/**
 * Block until the user has acknowledged the model download. Returns true if
 * already consented or the user accepts; false if they cancel.
 */
export function requestAiModelConsent(model: AiModelInfo): Promise<boolean> {
  if (hasStoredConsent(model.id)) return Promise.resolve(true)
  if (pending) {
    // Coalesce concurrent requests for the same model — a single dialog
    // serves them all. Different models queue.
    if (pending.model.id === model.id) {
      const existing = pending
      return new Promise<boolean>((resolve) => {
        const prev = existing.resolve
        existing.resolve = (granted) => { prev(granted); resolve(granted) }
      })
    }
  }
  return new Promise<boolean>((resolve) => {
    pending = {
      model,
      resolve: (granted) => {
        if (granted) storeConsent(model.id)
        pending = null
        notify()
        resolve(granted)
      },
    }
    notify()
  })
}

function getPending(): PendingRequest | null { return pending }

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePendingAiConsent(): PendingRequest | null {
  return useSyncExternalStore(subscribe, getPending, () => null)
}

export const WHISPER_MODEL: AiModelInfo = {
  id: "whisper",
  label: "Whisper (transcription)",
  sizeMb: 140,
  rationale:
    "Powers automatic word-level timing of recordings so you can scrub and karaoke playback. Runs entirely in your browser — recordings never leave your device.",
}

export const KOKORO_MODEL: AiModelInfo = {
  id: "kokoro",
  label: "Kokoro (text-to-speech)",
  sizeMb: 80,
  rationale:
    "Generates a clean voice rendering of cell text. Runs entirely in your browser — your text isn't sent to any server.",
}

export const MMS_MODEL: AiModelInfo = {
  id: "mms",
  label: "MMS (multilingual TTS)",
  sizeMb: 130,
  rationale:
    "Meta's MMS-TTS runs in your browser from browser-ready ONNX language models. Each language is downloaded the first time you use it.",
}
