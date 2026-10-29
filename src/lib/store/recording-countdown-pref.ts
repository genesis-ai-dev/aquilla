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
 *
 * AQU-2264: it now follows the PERSON across devices when they are signed in
 * (see `src/lib/prefs/person-prefs.ts`); the key above is this device's own
 * value, used when signed out and as the first device's offer.
 */

import { recorderCountdownBeepPref, recorderCountdownPref } from "@/lib/prefs/person-pref-list"
import { resetPersonPrefCachesForTests, usePersonPref } from "@/lib/prefs/person-prefs"

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

export function getRecordingCountdownSpeed(): CountdownSpeed {
  return recorderCountdownPref.get()
}

export function setRecordingCountdownSpeed(speed: CountdownSpeed): void {
  recorderCountdownPref.set(speed)
}

/** Reactive read of the countdown preference. */
export function useRecordingCountdownSpeed(): CountdownSpeed {
  return usePersonPref(recorderCountdownPref)
}

/**
 * "Countdown beep": the 3-2-1 tones. It was a plain `useState(true)` in the
 * recorder, so it came back on every time the recorder opened (AQU-2264).
 * Remembered now, on by default. Device key `aq.recording-countdown-beep.v1`
 * (`"off"` when turned off; absent means on).
 */
export function getRecordingCountdownBeep(): boolean {
  return recorderCountdownBeepPref.get()
}

export function setRecordingCountdownBeep(on: boolean): void {
  recorderCountdownBeepPref.set(on)
}

/** Reactive read of the countdown beep. */
export function useRecordingCountdownBeep(): boolean {
  return usePersonPref(recorderCountdownBeepPref)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingCountdownCacheForTests(): void {
  resetPersonPrefCachesForTests()
}
