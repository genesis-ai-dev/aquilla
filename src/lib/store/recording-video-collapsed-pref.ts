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
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.recording-video-collapsed.v1"

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: boolean | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(STORAGE_KEY) === "on"
  } catch {
    return false
  }
}

function peek(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

/** True when the recorder should hide the film and show the narrow column. */
export function getRecordingVideoCollapsed(): boolean {
  return peek()
}

export function setRecordingVideoCollapsed(collapsed: boolean): void {
  cached = collapsed
  if (typeof localStorage !== "undefined") {
    try {
      if (collapsed) localStorage.setItem(STORAGE_KEY, "on")
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
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

/** Reactive read of the collapse preference. */
export function useRecordingVideoCollapsed(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingVideoCollapsedCacheForTests(): void {
  cached = undefined
}
