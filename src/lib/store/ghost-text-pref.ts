/**
 * ghost-text-pref — device-scoped switch for BIA ghost-text suggestions in
 * the target editor.
 *
 * Off by default (AQU-2117): the suggestion is an aid a translator opts into
 * from View settings, not something every project starts with. Stored only
 * when the user opts IN, so a missing or cleared key reads as "off".
 *
 * Key schema: `aq.ghost-text.v2` (value `"on"`; absent = off). The v1 key
 * (`aq.ghost-text.v1`) only ever held `"off"` under the old on-by-default
 * scheme; it is never read — every browser is off until it opts in here — and
 * is dropped on the next write.
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.ghost-text.v2"
const LEGACY_STORAGE_KEY = "aq.ghost-text.v1"

const listeners = new Set<() => void>()
let cached: boolean | undefined

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

export function getGhostTextEnabled(): boolean {
  return peek()
}

export function setGhostTextEnabled(on: boolean): void {
  cached = on
  if (typeof localStorage !== "undefined") {
    try {
      if (on) localStorage.setItem(STORAGE_KEY, "on")
      else localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
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
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetGhostTextPrefCacheForTests(): void {
  cached = undefined
}
