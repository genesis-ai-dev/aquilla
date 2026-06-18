// Per-project "most recently used voices" — an ordered list of voiceIds, most
// recent first, written every time a line is voiced with a voice. Client-owned
// and durable (localStorage keyed by projectId), same threat model as
// audio-cell-prefs: nothing sensitive, just an ordering of ids.
//
// Reactive via useSyncExternalStore so the per-line cast strip re-orders the
// moment a voice is used anywhere. The Audio lens uses this to surface the few
// voices you actually reach for and tuck the long tail (60+ voices) behind a
// "More" picker, instead of clogging every row with the whole cast.

import { useSyncExternalStore } from "react"

const PREFIX = "frontier:voice-recency:"
const LIMIT = 50

const EMPTY: readonly string[] = Object.freeze([])

function storageKey(projectId: string): string {
  return PREFIX + projectId
}

// Stable per-project snapshot cache so useSyncExternalStore returns a
// referentially-stable array (only re-renders when the order actually changes).
const snapshotCache = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()

function notify(): void { for (const l of listeners) l() }

function readRaw(projectId: string): string[] {
  try {
    if (typeof localStorage === "undefined") return []
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

function peek(projectId: string): readonly string[] {
  const cached = snapshotCache.get(projectId)
  if (cached) return cached
  const fromLs = readRaw(projectId)
  const stable = fromLs.length ? Object.freeze(fromLs) : EMPTY
  snapshotCache.set(projectId, stable)
  return stable
}

/** Mark a voice as just-used: moves it to the front of the project's MRU list. */
export function touchVoice(projectId: string, voiceId: string): void {
  if (!projectId || !voiceId) return
  const cur = peek(projectId)
  if (cur[0] === voiceId) return // already most-recent; no-op (and stable ref)
  const next = [voiceId, ...cur.filter((id) => id !== voiceId)].slice(0, LIMIT)
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(storageKey(projectId), JSON.stringify(next))
    }
  } catch {
    /* quota / access denied — in-memory cache still reflects the change */
  }
  snapshotCache.set(projectId, Object.freeze(next))
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Subscribe to a project's most-recently-used voice ordering (newest first). */
export function useVoiceRecency(projectId: string): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => peek(projectId),
    () => EMPTY,
  )
}
