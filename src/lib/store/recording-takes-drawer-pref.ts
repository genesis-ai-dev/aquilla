/**
 * recording-takes-drawer-pref — device-scoped preference for how the recorder's
 * takes drawer rests. (AQU-1217)
 *
 * Sam, 2026-09-28: the drawer works the same whether the film is showing or
 * not, and where it rests is a setting. OPEN (semi-open): the takes that fit
 * show under the recorder, and the chevron beside "Takes" pulls up the rest.
 * CLOSED: only the "Takes" bar shows, and its chevron raises the list. Either
 * way the raised list is as tall as its takes, up to the room under the header.
 *
 * Defaults to OPEN. Stored inverted (only the opt-OUT is persisted) so a
 * missing key reads as the default. A DEVICE setting, like the recorder's
 * others: it is about how this operator likes to work, not about the project.
 *
 * Key schema: `aq.recording-takes-drawer.v1` (stores `"closed"` when turned
 * off; absent means open).
 *
 * AQU-2264: it now follows the PERSON across devices when they are signed in
 * (see `src/lib/prefs/person-prefs.ts`); the key above is this device's own
 * value, used when signed out and as the first device's offer.
 */

import { recorderKeepTakesDrawerOpenPref } from "@/lib/prefs/person-pref-list"
import { resetPersonPrefCachesForTests, usePersonPref } from "@/lib/prefs/person-prefs"

export function getRecordingTakesDrawerOpen(): boolean {
  return recorderKeepTakesDrawerOpenPref.get()
}

export function setRecordingTakesDrawerOpen(open: boolean): void {
  recorderKeepTakesDrawerOpenPref.set(open)
}

/** Reactive read of where the takes drawer rests. */
export function useRecordingTakesDrawerOpen(): boolean {
  return usePersonPref(recorderKeepTakesDrawerOpenPref)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingTakesDrawerCacheForTests(): void {
  resetPersonPrefCachesForTests()
}
