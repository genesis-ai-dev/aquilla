/**
 * recording-film-audible-pref — device-scoped preference for whether the film
 * shown inside the recording modal plays with sound.
 *
 * The picture is muted by default and that default is load-bearing, not a
 * nicety: the mic is opened with echoCancellation, noiseSuppression and
 * autoGainControl all false (so a take is clean), which means an audible film
 * on speakers is recorded into the take. Unmuting is therefore a
 * headphones-only studio case, and the modal says so in the control's copy and
 * in a persistent warning under the picture.
 *
 * A device setting, not a project one — whether sound leaks is a property of
 * the room and the headphones, i.e. of where you are sitting.
 *
 * Stored only when the user opts IN to audible, so a missing, cleared or
 * corrupt key reads as the safe state rather than as one that quietly ruins
 * every take.
 *
 * Key schema: `aq.recording-film-audible.v1` (value `"on"`; absent means muted).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.recording-film-audible.v1"

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: boolean | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(STORAGE_KEY) === "on"
  } catch {
    return false
  }
}

function peek(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

/** True when the film in the recording modal should play with sound. */
export function getRecordingFilmAudible(): boolean {
  return peek()
}

export function setRecordingFilmAudible(audible: boolean): void {
  cached = audible
  if (typeof localStorage !== "undefined") {
    try {
      if (audible) localStorage.setItem(STORAGE_KEY, "on")
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
    }
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive read of the film-audible preference. */
export function useRecordingFilmAudible(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingFilmAudibleCacheForTests(): void {
  cached = undefined
}
