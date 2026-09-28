/**
 * show-hidden-cells-pref — device-scoped preference for revealing cells parked
 * with "Hide cell" (AQU-1422).
 *
 * Off is the default and the point: a hidden cell is hidden. Turning it on does
 * not un-hide anything for anybody — it only draws the parked rows back into
 * THIS screen's list, dimmed and eye-off badged, so a source editor can see what
 * they have parked and bring one back.
 *
 * A device setting, not a project or file one, and the same reasoning as
 * `milestone-split-pref`: it is about the pass you are doing on this screen.
 * Someone auditing a partner's import turns it on for that sitting; the
 * translators on the same project never see the control at all, because only
 * people who may edit source text are offered it.
 *
 * NOT a permission. The pref says "draw them"; who may hide, show, or even know
 * a hidden cell exists is decided where the controls are drawn, against the same
 * gate as "Edit text".
 *
 * Stored only when the user opts IN, so a missing or cleared key reads as
 * "hidden cells stay hidden" — the default the feature was built around.
 *
 * Key schema: `aq.show-hidden-cells.v1` (value `"on"`; absent = hidden).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.show-hidden-cells.v1"

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

/** True when parked cells should be drawn (dimmed) instead of dropped. */
export function getShowHiddenCells(): boolean {
  return peek()
}

export function setShowHiddenCells(show: boolean): void {
  cached = show
  if (typeof localStorage !== "undefined") {
    try {
      if (show) localStorage.setItem(STORAGE_KEY, "on")
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

/** Reactive read of the "Show hidden cells" preference. */
export function useShowHiddenCells(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetShowHiddenCellsCacheForTests(): void {
  cached = undefined
}
