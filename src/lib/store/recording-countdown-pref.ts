/**
 * recording-countdown-pref — device-scoped preference controlling whether the
 * recording modal runs its 3-2-1 countdown before a take, and how fast.
 *
 * The countdown is a cue, and a cue is worth three seconds exactly once per
 * performance. An operator working down a file of short lines — or re-recording
 * one line until it lands — pays it on every take, and the existing "Countdown
 * beep" toggle only makes that wait silent, not shorter. AQU-1209 made the
 * count itself optional, the way the Codex extension already does.
 *
 * AQU-1210 (Sam, 2026-09-25) made it ONE four-way choice: Off, Fast (half a
 * second per count), Normal (one second, the count as it always was) and Slow
 * (a second and a half). It replaced the on/off switch in the same place.
 *
 * Defaults to Normal, which is the behaviour that existed before either
 * change, so nothing moves for anyone who never touches it. Only a departure
 * from Normal is stored, under the ORIGINAL key and with the original "off"
 * value — so an operator who had turned the count off still has it off, and a
 * build from before this change still reads "fast"/"slow" as "on". Same shape
 * as `recording-auto-advance-pref`, and a DEVICE setting for the same reason:
 * it describes how this operator likes to work, not anything about the project.
 *
 * Key schema: `aq.recording-countdown.v1` — `"off"`, `"fast"` or `"slow"`;
 * absent (or anything else) means Normal.
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.recording-countdown.v1"

export type CountdownSpeed = "off" | "fast" | "normal" | "slow"

export const COUNTDOWN_SPEEDS: readonly CountdownSpeed[] = ["off", "fast", "normal", "slow"]

/** Milliseconds per count. Off has none: there is no count. */
export const COUNTDOWN_STEP_MS: Record<Exclude<CountdownSpeed, "off">, number> = {
  fast: 500,
  normal: 1000,
  slow: 1500,
}

/** The step for a speed, or null when the count is off. */
export function countdownStepMs(speed: CountdownSpeed): number | null {
  return speed === "off" ? null : COUNTDOWN_STEP_MS[speed]
}

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: CountdownSpeed | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): CountdownSpeed {
  if (typeof localStorage === "undefined") return "normal"
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === "off" || v === "fast" || v === "slow" ? v : "normal"
  } catch {
    return "normal"
  }
}

function peek(): CountdownSpeed {
  if (cached === undefined) cached = read()
  return cached
}

export function getRecordingCountdownSpeed(): CountdownSpeed {
  return peek()
}

export function setRecordingCountdownSpeed(speed: CountdownSpeed): void {
  cached = speed
  if (typeof localStorage !== "undefined") {
    try {
      if (speed === "normal") localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, speed)
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
export function useRecordingCountdownSpeed(): CountdownSpeed {
  return useSyncExternalStore(subscribe, peek, () => "normal" as const)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingCountdownCacheForTests(): void {
  cached = undefined
}
