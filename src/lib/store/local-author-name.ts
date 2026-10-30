/**
 * AQU-2259: the name your edits carry when you work WITHOUT signing in.
 *
 * It used to be the "User → Username" field in each project's settings
 * (placeholder "local"), stored on that browser's copy of the project. It is
 * a person's own setting, so it lives in Preferences now, kept on this
 * device like the rest of Preferences. Signed in, the account's username is
 * used and this is never read — exactly as before.
 *
 * A name set the old way, on one project, is still honoured for that project
 * when this is empty (`authorNameFor`), so nobody's history changes name.
 *
 * Key schema: `aq.local-author-name.v1` (a trimmed string; absent = unset).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.local-author-name.v1"

/** The Preferences row's element id, for links that point at it. */
export const LOCAL_AUTHOR_NAME_SETTING_ID = "pref-author-name"
const MAX_LENGTH = 80

const listeners = new Set<() => void>()
let cached: string | undefined

function read(): string {
  if (typeof localStorage === "undefined") return ""
  try {
    return (localStorage.getItem(STORAGE_KEY) ?? "").slice(0, MAX_LENGTH)
  } catch {
    return ""
  }
}

export function getLocalAuthorName(): string {
  if (cached === undefined) cached = read()
  return cached
}

export function setLocalAuthorName(value: string): void {
  const next = value.slice(0, MAX_LENGTH)
  cached = next
  try {
    if (next.trim()) localStorage.setItem(STORAGE_KEY, next)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage blocked: the value lives for this page only */
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    cached = read()
    listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function useLocalAuthorName(): string {
  return useSyncExternalStore(subscribe, getLocalAuthorName, () => "")
}

/**
 * The author name for an edit: the signed-in account, else the name set in
 * Preferences, else the name an older build saved on this project, else
 * "local" — the order the old per-project field already followed, with the
 * Preferences name in the place it moved to.
 */
export function authorNameFor(
  sessionUsername: string | null | undefined,
  projectUsername: string | null | undefined,
  localName: string = getLocalAuthorName(),
): string {
  return sessionUsername || localName.trim() || projectUsername || "local"
}

/** Test seam. */
export function resetLocalAuthorNameForTests(): void {
  cached = undefined
}
