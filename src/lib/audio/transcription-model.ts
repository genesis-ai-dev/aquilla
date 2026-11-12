import { useSyncExternalStore } from "react"

/**
 * Which hosted model runs (transcription-models spec §6). "auto" lets the
 * server pick by language (Qwen3-ASR for Chinese varieties, Whisper, then
 * Omnilingual CTC) and never picks zero-shot; the rest pin one model.
 */
export type TranscriptionModel = "auto" | "whisper" | "qwen3-asr" | "omni-ctc" | "omni-zs"
export const TRANSCRIPTION_MODELS: readonly TranscriptionModel[] =
  ["auto", "whisper", "qwen3-asr", "omni-ctc", "omni-zs"]
const isModel = (value: string | null): value is TranscriptionModel =>
  (TRANSCRIPTION_MODELS as readonly (string | null)[]).includes(value)
const prefix = "aq.transcription-model.v1."
const listeners = new Set<() => void>()
const memory = new Map<string, TranscriptionModel>()
const keyFor = (username?: string) => prefix + encodeURIComponent(username ?? "signed-out")

/** Account-specific in this browser, like the provider choice beside it. */
export function getTranscriptionModel(username?: string): TranscriptionModel {
  const key = keyFor(username)
  if (memory.has(key)) return memory.get(key)!
  try {
    const stored = localStorage.getItem(key)
    return isModel(stored) ? stored : "auto"
  }
  catch { return "auto" }
}

export function setTranscriptionModel(
  username: string | undefined, model: TranscriptionModel,
): void {
  const key = keyFor(username)
  try {
    localStorage.setItem(key, model)
    memory.delete(key)
  } catch { memory.set(key, model) }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

export function useTranscriptionModel(username?: string) {
  return useSyncExternalStore(subscribe,
    () => getTranscriptionModel(username), () => "auto" as const)
}
