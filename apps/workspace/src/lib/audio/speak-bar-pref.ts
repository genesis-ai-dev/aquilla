// Per-project preference for whether the TTS ("Speak") bar is visible above
// the editor. Off by default — the bar adds visual weight and mental load
// for users who aren't generating voice on this project. Stored in
// localStorage; not synced (this is a local UI preference, not collab data).

import { useSyncExternalStore } from "react"

const PREFIX = "frontier:speak-bar-enabled:"

function key(projectId: string): string {
  return PREFIX + projectId
}

const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function safeGet(k: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null
  } catch {
    return null
  }
}

function safeSet(k: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return
    if (value === null) localStorage.removeItem(k)
    else localStorage.setItem(k, value)
  } catch { /* quota / access denied — ignore */ }
}

export function getSpeakBarEnabled(projectId: string): boolean {
  return safeGet(key(projectId)) === "1"
}

export function setSpeakBarEnabled(projectId: string, value: boolean): void {
  safeSet(key(projectId), value ? "1" : null)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => { if (e.key?.startsWith(PREFIX)) listener() }
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

export function useSpeakBarEnabled(projectId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? getSpeakBarEnabled(projectId) : false),
    () => false,
  )
}
