/**
 * recording-auto-advance-pref — device-scoped preference controlling whether
 * saving a take in the recording modal jumps to the next cell.
 *
 * Auto-advance is what you want on a fast pass down a file, and exactly what
 * you don't want when working a single line — recording, listening back and
 * recording again. SUB-50 makes it a toggle in the modal header rather than a
 * fixed behaviour.
 *
 * Defaults to ON, which is the behaviour that existed before the toggle, so
 * nothing changes for anyone who never touches it. Stored inverted (we persist
 * only the opt-OUT) so a missing key reads as the default.
 *
 * Key schema: `aq.recording-auto-advance.v1` (stores `"off"` when the user has
 * turned auto-advance off; absent means on).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.recording-auto-advance.v1"

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: boolean | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): boolean {
  if (typeof localStorage === "undefined") return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off"
  } catch {
    return true
  }
}

function peek(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

/** True when saving a take should move on to the next cell. */
export function getRecordingAutoAdvance(): boolean {
  return peek()
}

export function setRecordingAutoAdvance(enabled: boolean): void {
  cached = enabled
  if (typeof localStorage !== "undefined") {
    try {
      if (enabled) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, "off")
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
    }
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Reactive read of the auto-advance preference. */
export function useRecordingAutoAdvance(): boolean {
  return useSyncExternalStore(subscribe, peek, () => true)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingAutoAdvanceCacheForTests(): void {
  cached = undefined
}
