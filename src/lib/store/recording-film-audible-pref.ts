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
 *
 * AQU-2264: it now follows the PERSON across devices when they are signed in
 * (see `src/lib/prefs/person-prefs.ts`); the key above is this device's own
 * value, used when signed out and as the first device's offer.
 */

import { recorderFilmAudiblePref } from "@/lib/prefs/person-pref-list"
import { resetPersonPrefCachesForTests, usePersonPref } from "@/lib/prefs/person-prefs"

export function getRecordingFilmAudible(): boolean {
  return recorderFilmAudiblePref.get()
}

export function setRecordingFilmAudible(audible: boolean): void {
  recorderFilmAudiblePref.set(audible)
}

/** Reactive read of the film-audible preference. */
export function useRecordingFilmAudible(): boolean {
  return usePersonPref(recorderFilmAudiblePref)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingFilmAudibleCacheForTests(): void {
  resetPersonPrefCachesForTests()
}
