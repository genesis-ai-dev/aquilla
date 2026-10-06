/**
 * recording-takes-drawer-pref — device-scoped preference for how the recorder's
 * takes drawer rests. (AQU-1217)
 *
 * Sam, 2026-09-28: the drawer works the same whether the film is showing or
 * not, and where it rests is a setting. OPEN (semi-open): the takes that fit
 * show under the recorder, and the chevron beside "Takes" pulls up the rest.
 * CLOSED: only the "Takes" bar shows, and its chevron raises the list. Either
 * way the raised list is as tall as its takes, up to the room under the header.
 *
 * Defaults to OPEN. Stored inverted (only the opt-OUT is persisted) so a
 * missing key reads as the default. A DEVICE setting, like the recorder's
 * others: it is about how this operator likes to work, not about the project.
 *
 * Key schema: `aq.recording-takes-drawer.v1` (stores `"closed"` when turned
 * off; absent means open).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.recording-takes-drawer.v1"

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: boolean | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): boolean {
  if (typeof localStorage === "undefined") return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== "closed"
  } catch {
    return true
  }
}

function peek(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

/** True when the takes drawer rests open under the recorder. */
export function getRecordingTakesDrawerOpen(): boolean {
  return peek()
}

export function setRecordingTakesDrawerOpen(open: boolean): void {
  cached = open
  if (typeof localStorage !== "undefined") {
    try {
      if (open) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, "closed")
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

/** Reactive read of the takes-drawer preference. */
export function useRecordingTakesDrawerOpen(): boolean {
  return useSyncExternalStore(subscribe, peek, () => true)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetRecordingTakesDrawerCacheForTests(): void {
  cached = undefined
}
