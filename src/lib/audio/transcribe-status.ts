// In-memory, page-local registry of which cells are currently being
// transcribed and what their last result was. Lives outside the Y.Doc on
// purpose — transcription state is a per-client UX concern, not collab data.
// React subscribes via useTranscribeStatus(audioId).

import { useSyncExternalStore } from "react"

export type TranscribeStatus =
  | { kind: "idle" }
  | { kind: "loading"; loaded: number; total: number; file: string }
  | { kind: "transcribing" }
  | { kind: "done"; wordCount: number; durationMs: number }
  | { kind: "error"; message: string }

const IDLE: TranscribeStatus = { kind: "idle" }
const status = new Map<string, TranscribeStatus>()
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

export function setTranscribeStatus(audioId: string, s: TranscribeStatus): void {
  status.set(audioId, s)
  notify()
}

export function getTranscribeStatus(audioId: string): TranscribeStatus {
  return status.get(audioId) ?? IDLE
}

export function clearTranscribeStatus(audioId: string): void {
  status.delete(audioId)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useTranscribeStatus(audioId: string | undefined): TranscribeStatus {
  return useSyncExternalStore(
    subscribe,
    () => (audioId ? getTranscribeStatus(audioId) : IDLE),
    () => IDLE,
  )
}
