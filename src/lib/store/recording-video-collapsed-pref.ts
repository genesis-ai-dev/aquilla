/**
 * recording-video-collapsed-pref — device-scoped preference for whether the
 * recording modal shows the film beside the line, or collapses to the narrow
 * recording column on its own.
 *
 * Two layouts, one control (Sam's design exploration, 2026-08-13): expanded is
 * a 16:9 room with the picture on the left, collapsed is a tall portrait column
 * whose lower half is the takes drawer. The toggle only exists when the line
 * HAS a film — a file with no video is always the collapsed layout, and this
 * preference is simply not consulted there.
 *
 * A device setting, not a project one, and for the ordinary reason: it is about
 * the screen in front of you and the pass you are doing. Someone running an
 * audio-only pass over a video project collapses once and stays collapsed;
 * someone dubbing to picture never touches it.
 *
 * Stored only when the user opts IN to collapsed, so a missing or cleared key
 * reads as "show the film" — the default the feature was built for.
 *
 * Key schema: `aq.recording-video-collapsed.v1` (value `"on"`; absent = expanded).
 *
 * AQU-2264: it now follows the PERSON across devices when they are signed in
 * (see `src/lib/prefs/person-prefs.ts`); the key above is this device's own
 * value, used when signed out and as the first device's offer.
 */

import { recorderFilmCollapsedPref } from "@/lib/prefs/person-pref-list"
import { resetPersonPrefCachesForTests, usePersonPref } from "@/lib/prefs/person-prefs"

export function getRecordingVideoCollapsed(): boolean {
  return recorderFilmCollapsedPref.get()
}

export function setRecordingVideoCollapsed(collapsed: boolean): void {
  recorderFilmCollapsedPref.set(collapsed)
}

/** Reactive read of the collapsed-layout preference. */
export function useRecordingVideoCollapsed(): boolean {
  return usePersonPref(recorderFilmCollapsedPref)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingVideoCollapsedCacheForTests(): void {
  resetPersonPrefCachesForTests()
}
