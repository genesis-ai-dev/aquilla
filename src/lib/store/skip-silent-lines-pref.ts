/**
 * skip-silent-lines-pref — device-scoped playback setting, "Skip lines with
 * nothing to play" in the timeline's ⋯ settings. (AQU-2251)
 *
 * Sam, Oct 28: following the recordings, a line nobody has recorded yet (a
 * book's stand-in) has nothing to hear, and playback steps over it. That is
 * right for listening to what is recorded, but sometimes you want playback to
 * take the verses' estimated time before the next recording, so you hear the
 * book's pacing. On (the default) is today's stepping over; off plays a line
 * with nothing to hear through in silence, for as long as the timeline makes
 * it. The same setting jumps over such lines when the file follows its source
 * (lib/timeline/silent-lines).
 *
 * A device setting, like the snap magnet and the playback quality beside it:
 * it is how this person likes to listen, not anything about the project.
 * Stored only when turned OFF, so a missing key reads as the default.
 * Key schema: `aq.skip-silent-lines.v1` (value `"off"`).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.skip-silent-lines.v1"

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

/** Whether playback steps over lines with nothing to hear (plain read for non-React code). */
export function getSkipSilentLinesPref(): boolean {
  return peek()
}

export function setSkipSilentLinesPref(on: boolean): void {
  cached = on
  if (typeof localStorage !== "undefined") {
    try {
      if (on) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, "off")
    } catch {
      // private mode / storage blocked — the in-memory value still holds for this visit
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

/** Reactive read of the setting. */
export function useSkipSilentLinesPref(): boolean {
  return useSyncExternalStore(subscribe, peek, () => true)
}

/** Test helper: forget the cached value so a fresh localStorage is read. */
export function resetSkipSilentLinesPrefCacheForTests(): void {
  cached = undefined
}
