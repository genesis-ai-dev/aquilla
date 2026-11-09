/**
 * paratext-scan-pref — device-scoped record that a Paratext scan has
 * succeeded on this computer.
 *
 * The "This computer" workspace shows a short permission-prep step before
 * its first scan, because the first read of a Paratext folder can trigger a
 * macOS/Windows file-access prompt. Once a scan has completed without error,
 * that prompt (if any) has been answered, so later visits scan straight away.
 *
 * Key schema: `aq.paratext-scan.v1` (value `"ok"`; absent = not yet).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.paratext-scan.v1"

const listeners = new Set<() => void>()
let cached: boolean | undefined

function read(): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(STORAGE_KEY) === "ok"
  } catch {
    return false
  }
}

function peek(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

export function getParatextScanReady(): boolean {
  return peek()
}

export function setParatextScanReady(ready: boolean): void {
  cached = ready
  if (typeof localStorage !== "undefined") {
    try {
      if (ready) localStorage.setItem(STORAGE_KEY, "ok")
      else localStorage.removeItem(STORAGE_KEY)
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

/** Reactive read: has a Paratext scan already succeeded on this device? */
export function useParatextScanReady(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetParatextScanPrefForTests(): void {
  cached = undefined
}
