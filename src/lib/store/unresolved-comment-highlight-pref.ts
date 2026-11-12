/**
 * unresolved-comment-highlight-pref — device-scoped preference that lights up
 * every editor row carrying an unresolved comment thread (AQU-1259).
 *
 * This is NOT the always-on per-cell marker AQU-599 shipped. That one answers
 * "does this row I am already looking at have a comment?" with a soft inset
 * ring and a small speech-bubble badge, deliberately quiet enough to sit in a
 * table a translator reads all day. It does not answer the reviewer's
 * question — "which rows in this file still need me?" — because at a scanning
 * distance the ring is invisible. This preference is that second question:
 * switched on, the rows with unresolved threads carry a loud start-edge accent
 * a reviewer can find without reading a word. Switched off, the AQU-599
 * marker remains; only the accent goes.
 *
 * A device setting, not a project or file one, for the same reason the
 * milestone split is: it describes the pass you are doing on this screen. A
 * consultant working through a reviewer's notes switches it on for that
 * session; a translator drafting never touches it.
 *
 * Stored only when the user opts IN, so a missing or cleared key reads as
 * "no accent" — the behaviour every existing file had before this preference.
 *
 * Key schema: `aq.unresolved-comment-highlight.v1` (value `"on"`; absent = off).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.unresolved-comment-highlight.v1"

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

/** True when rows with an unresolved comment thread get the scanning accent. */
export function getUnresolvedCommentHighlight(): boolean {
  return peek()
}

export function setUnresolvedCommentHighlight(on: boolean): void {
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

/** Reactive read of the unresolved-comment highlight preference. */
export function useUnresolvedCommentHighlight(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetUnresolvedCommentHighlightCacheForTests(): void {
  cached = undefined
}
