import { useSyncExternalStore } from "react"
import type { FrontierSession } from "@/lib/frontier/types"

export type TranscriptionProvider = "hosted" | "local"
const prefix = "aq.transcription-provider.v1."
const listeners = new Set<() => void>()
const memory = new Map<string, TranscriptionProvider>()
const keyFor = (username?: string) => prefix + encodeURIComponent(username ?? "signed-out")

/** Account-specific in this browser, alongside the device's model cache. */
export function getTranscriptionProvider(username?: string): TranscriptionProvider {
  const key = keyFor(username)
  if (memory.has(key)) return memory.get(key)!
  try { return localStorage.getItem(key) === "local" ? "local" : "hosted" }
  catch { return "hosted" }
}

export function setTranscriptionProvider(
  username: string | undefined, provider: TranscriptionProvider,
): void {
  const key = keyFor(username)
  try {
    localStorage.setItem(key, provider)
    memory.delete(key)
  } catch { memory.set(key, provider) }
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

export function useTranscriptionProvider(username?: string) {
  return useSyncExternalStore(subscribe,
    () => getTranscriptionProvider(username), () => "hosted" as const)
}

/** One decision shared by automatic and manual transcription. */
export function usesHostedTranscription(
  session: FrontierSession | null | undefined, projectId?: string,
): boolean {
  return Boolean(session && projectId && navigator.onLine !== false
    && getTranscriptionProvider(session.username) === "hosted")
}
