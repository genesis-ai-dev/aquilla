/**
 * milestone-split-pref — device-scoped preference for paging the editor
 * table one milestone (chapter, slide, section, …) at a time.
 *
 * Off is the default the table was built for: every cell of the file in one
 * continuous list, with the navigator only scrolling. Opting in hides every
 * cell that is not on the current division; the arrows then turn the page.
 *
 * A device setting, not a project or file one: it is about the pass you are
 * doing on this screen. Someone working a long scripture file pages once and
 * stays paged; someone skimming a short document never touches it.
 *
 * Stored only when the user opts IN, so a missing or cleared key reads as
 * "show the whole file" — the default the feature was built around.
 *
 * Key schema: `aq.milestone-split.v1` (value `"on"`; absent = continuous).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.milestone-split.v1"

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

/** True when the editor should render only the current milestone's cells. */
export function getMilestoneSplit(): boolean {
  return peek()
}

export function setMilestoneSplit(split: boolean): void {
  cached = split
  if (typeof localStorage !== "undefined") {
    try {
      if (split) localStorage.setItem(STORAGE_KEY, "on")
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

/** Reactive read of the split-into-milestones preference. */
export function useMilestoneSplit(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetMilestoneSplitCacheForTests(): void {
  cached = undefined
}
