import { useSyncExternalStore } from "react"

/**
 * Which hosted model runs (Omnilingual ASR spec §5). "auto" lets the server
 * pick Whisper or Omnilingual CTC by language; "zs" is the per-user opt-in to
 * Omnilingual Zero-Shot, which learns the language from this project's takes.
 */
export type TranscriptionModel = "auto" | "zs"
const prefix = "aq.transcription-model.v1."
const listeners = new Set<() => void>()
const memory = new Map<string, TranscriptionModel>()
const keyFor = (username?: string) => prefix + encodeURIComponent(username ?? "signed-out")

/** Account-specific in this browser, like the provider choice beside it. */
export function getTranscriptionModel(username?: string): TranscriptionModel {
  const key = keyFor(username)
  if (memory.has(key)) return memory.get(key)!
  try { return localStorage.getItem(key) === "zs" ? "zs" : "auto" }
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
