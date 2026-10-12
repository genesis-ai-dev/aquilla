/**
 * health-score-color-coding-pref — device-scoped preference that paints AI-draft
 * target words as supported (found in a cited example) vs guessed (#946).
 *
 * This is NOT the health ribbon / neighbor-confidence percentage. That number
 * stays on the row gutter. This preference answers the consultant's follow-up:
 * "when it says 9%, which words are those?" by colouring the draft itself.
 *
 * A device setting, not a project or file one, for the same reason the
 * unresolved-comment highlight is: it describes the pass you are doing on this
 * screen. Stored only when the user opts IN, so a missing or cleared key reads
 * as off — the rendering every existing file had before this preference.
 *
 * Key schema: `aq.health-score-color-coding.v1` (value `"on"`; absent = off).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.health-score-color-coding.v1"

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

/** True when AI-draft target words get supported/guessed colouring. */
export function getHealthScoreColorCoding(): boolean {
  return peek()
}

export function setHealthScoreColorCoding(on: boolean): void {
  cached = on
  if (typeof localStorage !== "undefined") {
    try {
      if (on) localStorage.setItem(STORAGE_KEY, "on")
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

/** Reactive read of the health-score colour-coding preference. */
export function useHealthScoreColorCoding(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetHealthScoreColorCodingCacheForTests(): void {
  cached = undefined
}
