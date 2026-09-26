/**
 * recording-film-follow-pref — device-scoped preference for whether the film
 * in the recording modal plays along when a take is played back. (AQU-1210)
 *
 * Sam, 2026-09-25: after Stop, playing the kept part of the take should play
 * the film with it — you judge a dub against the picture it was made for — and
 * whether it does is a setting. It covers both places a take is played inside
 * the recorder: the preview after Stop and the selected take on the ready
 * screen. It only matters on lines that have a film.
 *
 * Defaults to ON. Stored inverted (only the opt-OUT is persisted) so a missing
 * key reads as the default. A DEVICE setting, like the recorder's others: it is
 * about how this operator likes to review, not about the project. The film's
 * sound still follows its own mute setting (recording-film-audible-pref).
 *
 * Key schema: `aq.recording-film-follow.v1` (stores `"off"` when turned off;
 * absent means on).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.recording-film-follow.v1"

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

/** True when playing a take back in the recorder should play the film along. */
export function getRecordingFilmFollow(): boolean {
  return peek()
}

export function setRecordingFilmFollow(enabled: boolean): void {
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

/** Reactive read of the film play-along preference. */
export function useRecordingFilmFollow(): boolean {
  return useSyncExternalStore(subscribe, peek, () => true)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingFilmFollowCacheForTests(): void {
  cached = undefined
}
