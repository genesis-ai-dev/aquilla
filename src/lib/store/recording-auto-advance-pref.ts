/**
 * recording-auto-advance-pref — device-scoped preference controlling whether
 * saving a take in the recording modal jumps to the next cell.
 *
 * Auto-advance is what you want on a fast pass down a file, and exactly what
 * you don't want when working a single line — recording, listening back and
 * recording again. SUB-50 makes it a toggle in the modal header rather than a
 * fixed behaviour.
 *
 * Defaults to OFF (AQU-2620, Matthew, 2026-11-16): saving a take keeps you on
 * the same line with the recorder open unless you have switched it on. Stored
 * as the opt-IN (`"on"`), so a missing key reads as the default.
 *
 * Key schema: `aq.recording-auto-advance.v2` (stores `"on"` when the user has
 * turned auto-advance on; absent means off). The `.v1` key it replaces stored
 * the opt-OUT under the old ON default; nothing reads it any more, which is
 * what turns the default change into a one-time reset for people who already
 * had a stored value — see `recorderMoveOnAfterSavingPref` in
 * `src/lib/prefs/person-pref-list.ts` for the whole rule.
 *
 * AQU-2264: it now follows the PERSON across devices when they are signed in
 * (see `src/lib/prefs/person-prefs.ts`); the key above is this device's own
 * value, used when signed out and as the first device's offer.
 */

import { recorderMoveOnAfterSavingPref } from "@/lib/prefs/person-pref-list"
import { resetPersonPrefCachesForTests, usePersonPref } from "@/lib/prefs/person-prefs"

/** True when saving a take should move on to the next cell. */
export function getRecordingAutoAdvance(): boolean {
  return recorderMoveOnAfterSavingPref.get()
}

export function setRecordingAutoAdvance(enabled: boolean): void {
  recorderMoveOnAfterSavingPref.set(enabled)
}

/** Reactive read of the auto-advance preference. */
export function useRecordingAutoAdvance(): boolean {
  return usePersonPref(recorderMoveOnAfterSavingPref)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingAutoAdvanceCacheForTests(): void {
  resetPersonPrefCachesForTests()
}
