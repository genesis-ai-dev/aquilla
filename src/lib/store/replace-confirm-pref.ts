/**
 * replace-confirm-pref — device-scoped preference controlling whether the
 * "Replace existing translation?" confirmation dialog is shown when AI Generate
 * (the sparkle) is triggered on a cell that already contains a translation.
 *
 * The confirmation (FRO-278 / GenerateOverwriteDialog) is a useful safety net,
 * but power users found it repetitive when re-drafting many cells. AQU-591 lets
 * them opt out: once "Don't ask again" is chosen (or the Preferences toggle is
 * turned off), non-validated replacements proceed immediately.
 *
 * Safety carve-out: this preference NEVER suppresses the confirmation for a
 * VALIDATED cell — replacing a validated translation clears the validation, a
 * more destructive action that always deserves an explicit confirm. The skip
 * only applies to non-validated cells.
 *
 * Stored in localStorage and reactive via useSyncExternalStore so the dialog
 * checkbox and the Preferences toggle stay in sync across the app.
 *
 * Key schema: `aq.replace-confirm-pref.v1` (stores `true` when the user has
 * opted to SKIP the confirmation; absent/false means show it).
 *
 * AQU-591: allow disabling the sparkle-replace confirmation modal.
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.replace-confirm-pref.v1"

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: boolean | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function peek(): boolean {
  if (cached === undefined) cached = read()
  return cached
}

/** True when the user has opted to skip the replace confirmation dialog. */
export function getSkipReplaceConfirm(): boolean {
  return peek()
}

export function setSkipReplaceConfirm(skip: boolean): void {
  cached = skip
  if (typeof localStorage !== "undefined") {
    try {
      if (skip) localStorage.setItem(STORAGE_KEY, "true")
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // quota / access denied — in-memory cache still reflects the edit
    }
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Reactive read of the skip-replace-confirm preference. */
export function useSkipReplaceConfirm(): boolean {
  return useSyncExternalStore(subscribe, peek, () => false)
}
