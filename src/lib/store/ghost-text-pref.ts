/**
 * ghost-text-pref — device-scoped switch for BIA ghost-text suggestions in
 * the target editor.
 *
 * On by default again (Nov 2026). AQU-2117 turned it off because the
 * suggestion got in the way: it popped up on every focus, took Tab from cell
 * navigation and the plain → key, showed mid-sentence, and guessed the most
 * frequent word. The plugin now only suggests after typing, at the end of the
 * line, one word at a time — so the default is on and a translator opts OUT.
 *
 * Key schema: `aq.ghost-text.v3` (value `"off"`; absent = on). The v2 key only
 * ever held `"on"` (an opt-in under the off-by-default scheme) and v1 only
 * `"off"` from before that; neither is read, both are dropped on the next
 * write. Someone who turned it off under v1 sees it again, deliberately: what
 * they turned off is not what ships now.
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.ghost-text.v3"
const LEGACY_STORAGE_KEYS = ["aq.ghost-text.v2", "aq.ghost-text.v1"]

const listeners = new Set<() => void>()
let cached: boolean | undefined

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

export function getGhostTextEnabled(): boolean {
  return peek()
}

export function setGhostTextEnabled(on: boolean): void {
  cached = on
  if (typeof localStorage !== "undefined") {
    try {
      if (on) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, "off")
      for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key)
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
    }
  }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive read of the ghost-text preference. */
export function useGhostTextEnabled(): boolean {
  return useSyncExternalStore(subscribe, peek, () => true)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetGhostTextPrefCacheForTests(): void {
  cached = undefined
}
