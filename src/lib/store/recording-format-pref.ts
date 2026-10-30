/**
 * recording-format-pref — device-scoped preference for the format a microphone
 * take is captured in.
 *
 * Takes were webm/opus for their whole history because that is the only thing
 * MediaRecorder will produce; the 2026-08-12 client meeting asked for WAV, so
 * capture now runs through an AudioWorklet PCM path with webm/opus kept as the
 * opt-out (a compressed take is better than a broken one, and the recorder
 * falls back to it whenever the WAV path fails).
 *
 * A device setting, not a project one — the same rationale as
 * audio-quality-pref: it is a property of where you are sitting (which machine,
 * which mic, how much upload you have) rather than of the project. If the
 * client ever means "this project is *delivered* in WAV, enforce it for every
 * operator", that is a different, project-scoped and event-sourced feature:
 * this module would grow a project override consulted ahead of the stored
 * value, and the modal's pill would become a display of the effective format
 * rather than a control.
 *
 * Stored only when the user opts OUT to webm, so a missing key reads as WAV.
 * That is deliberate rather than incidental: a corrupt, cleared or
 * partially-written localStorage reads as the format the client asked for.
 *
 * Key schema: `aq.recording-format.v1` (value `"webm"`; absent means WAV).
 *
 * AQU-2264: it now follows the PERSON across devices when they are signed in
 * (see `src/lib/prefs/person-prefs.ts`); the key above is this device's own
 * value, used when signed out and as the first device's offer.
 */

import { recorderFormatPref } from "@/lib/prefs/person-pref-list"
import { resetPersonPrefCachesForTests, usePersonPref } from "@/lib/prefs/person-prefs"

export type RecordingFormat = "wav" | "webm"

/**
 * The format the next take should be captured in (plain read for non-React
 * code). The recorder reads this once at start() — never reactively, because a
 * mid-take flip cannot change bytes already captured.
 */
export function getRecordingFormatPref(): RecordingFormat {
  return recorderFormatPref.get()
}

export function setRecordingFormatPref(format: RecordingFormat): void {
  recorderFormatPref.set(format)
}

/** Reactive read of the capture-format preference. */
export function useRecordingFormatPref(): RecordingFormat {
  return usePersonPref(recorderFormatPref)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingFormatPrefCacheForTests(): void {
  resetPersonPrefCachesForTests()
}
