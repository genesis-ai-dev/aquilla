/**
 * ghost-text-pref — device-scoped switch for BIA ghost-text suggestions in
 * the target editor.
 *
 * On by default: the suggestion is a faint decoration that writes nothing
 * until Tab/→ accepts it. Stored only when the user opts OUT, so a missing or
 * cleared key reads as "on".
 *
 * Key schema: `aq.ghost-text.v1` (value `"off"`; absent = on).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.ghost-text.v1"

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
