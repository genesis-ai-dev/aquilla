/**
 * recording-countdown-pref — device-scoped preference controlling whether the
 * recording modal runs its 3-2-1 countdown before a take at all.
 *
 * The countdown is a cue, and a cue is worth three seconds exactly once per
 * performance. An operator working down a file of short lines — or re-recording
 * one line until it lands — pays it on every take, and the existing "Countdown
 * beep" toggle only makes that wait silent, not shorter. AQU-1209 makes the
 * count itself optional, the way the Codex extension already does.
 *
 * Defaults to ON, which is the behaviour that existed before the toggle, so
 * nothing changes for anyone who never touches it. Stored inverted (we persist
 * only the opt-OUT) so a missing key reads as the default. Same shape as
 * `recording-auto-advance-pref`, and a DEVICE setting for the same reason: it
 * describes how this operator likes to work, not anything about the project.
 *
 * Key schema: `aq.recording-countdown.v1` (stores `"off"` when the user has
 * turned the countdown off; absent means on).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.recording-countdown.v1"

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

/** True when pressing Record should run the 3-2-1 count before the take. */
export function getRecordingCountdown(): boolean {
  return peek()
}

export function setRecordingCountdown(enabled: boolean): void {
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

/** Reactive read of the countdown preference. */
export function useRecordingCountdown(): boolean {
  return useSyncExternalStore(subscribe, peek, () => true)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingCountdownCacheForTests(): void {
  cached = undefined
}
