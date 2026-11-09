// In-memory, page-local registry of which cells are currently being
// transcribed and what their last result was. Lives outside the Y.Doc on
// purpose — transcription state is a per-client UX concern, not collab data.
// React subscribes via useTranscribeStatus(audioId).

import { useSyncExternalStore } from "react"

export type TranscribeStatus =
  | { kind: "idle" }
  | { kind: "loading"; loaded: number; total: number; file: string }
  /** `waiting: "model"` — a zero-shot take queued behind the model's cold start;
   *  `"limit"` — AQU-2426: a take recorded with the mic waiting out the hosted
   *  limit, to transcribe by itself once it allows. */
  | { kind: "transcribing"; waiting?: "model" | "limit" }
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

/**
 * AQU-2426: a take recorded with the mic, refused by the hosted limit (60
 * requests per 15 minutes per person), waits and transcribes by itself once
 * the limit allows — as batch transcription already waits — instead of staying
 * "Not transcribed" for good. Hand this to `transcribeCell`'s `onRateLimited`.
 */
export function waitAtTranscribeLimit(
  audioId: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): (retryAfterSeconds: number) => Promise<void> {
  return async (retryAfterSeconds) => {
    setTranscribeStatus(audioId, { kind: "transcribing", waiting: "limit" })
    await sleep(Math.max(1, retryAfterSeconds) * 1000)
    setTranscribeStatus(audioId, { kind: "transcribing" })
  }
}
