// Browser-local API keys keyed by purpose. These follow the user across
// projects on this device — they're stored in localStorage, never synced
// to a server. Per-project overrides always win at read time.
//
// Threat model: localStorage is readable by any script running on this
// origin. Don't store keys you wouldn't paste into the project record on
// disk anyway. We don't encrypt — the project record itself isn't
// encrypted, and adding a key wrap on top adds friction without raising
// the bar against any realistic attacker.

import { useSyncExternalStore } from "react"

export type ApiKeyPurpose = "gemini-tts" | "completion"

const PREFIX = "frontier:user-api-key:"

function storageKey(purpose: ApiKeyPurpose): string {
  return PREFIX + purpose
}

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* quota / access denied — ignore */ }
}

export function getUserApiKey(purpose: ApiKeyPurpose): string | undefined {
  const v = safeGet(storageKey(purpose))?.trim()
  return v ? v : undefined
}

export function setUserApiKey(purpose: ApiKeyPurpose, value: string | undefined): void {
  safeSet(storageKey(purpose), value && value.trim() ? value.trim() : null)
  notify()
}

export function hasUserApiKey(purpose: ApiKeyPurpose): boolean {
  return Boolean(getUserApiKey(purpose))
}

/**
 * Resolve an API key with project-takes-precedence semantics.
 *
 * Precedence (FRO-433):
 *   1. project key  — per-project override (highest priority)
 *   2. user key     — browser-local key saved by this user
 *   3. org key      — synced org-level baseline (lowest priority)
 *
 * Returns undefined if none exists.
 */
export function resolveApiKey(
  purpose: ApiKeyPurpose,
  projectValue: string | undefined,
  orgValue?: string | undefined,
): string | undefined {
  const project = projectValue?.trim()
  if (project) return project
  const user = getUserApiKey(purpose)
  if (user) return user
  const org = orgValue?.trim()
  return org || undefined
}

// ── React subscription ─────────────────────────────────────────────────────

const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Hook: returns the user-saved key for a purpose. Updates on writes from
 *  any component, plus cross-tab via the storage event. */
export function useUserApiKey(purpose: ApiKeyPurpose): string | undefined {
  return useSyncExternalStore(
    (l) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === storageKey(purpose)) l()
      }
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
      const off = subscribe(l)
      return () => {
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
        off()
      }
    },
    () => getUserApiKey(purpose),
    () => undefined,
  )
}
