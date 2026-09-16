/**
 * Per-user, per-device default for the AI completion provider. Stored in
 * localStorage because it's a personal credential that must not sync across
 * devices. Used when a project has no custom provider of its own; a project
 * API key / custom endpoint beats this at request time in `complete()`.
 *
 * This is the *advanced* path: surfaced only in user Settings, never in the
 * onboarding wizard. The happy path is "sign in to Frontier — done."
 */

import { useSyncExternalStore } from "react"
import {
  ownerScopedLocalStorageKey,
  subscribeClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

const KEY = "aquilla:userProviderOverride"

export interface UserProviderOverride {
  /** OpenAI-compatible base URL (e.g. "https://openrouter.ai/api/v1"). */
  endpoint: string
  /** Optional model id. Empty string means "let the provider pick". */
  model?: string
  /** Optional bearer token for authenticated endpoints. */
  apiKey?: string
}

function storageKey(): string {
  return ownerScopedLocalStorageKey(KEY)
}

let snapshotKey: string | null = null
let snapshotRaw: string | null = null
let snapshot: UserProviderOverride | null = null

export function getUserProviderOverride(): UserProviderOverride | null {
  if (typeof localStorage === "undefined") return null
  try {
    const key = storageKey()
    const raw = localStorage.getItem(key)
    if (key === snapshotKey && raw === snapshotRaw) return snapshot
    snapshotKey = key
    snapshotRaw = raw
    if (!raw) {
      snapshot = null
      return null
    }
    const parsed = JSON.parse(raw) as Partial<UserProviderOverride>
    if (!parsed?.endpoint || typeof parsed.endpoint !== "string") {
      snapshot = null
      return null
    }
    snapshot = {
      endpoint: parsed.endpoint,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
    }
    return snapshot
  } catch {
    snapshotKey = null
    snapshotRaw = null
    snapshot = null
    return null
  }
}

export function setUserProviderOverride(override: UserProviderOverride): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(storageKey(), JSON.stringify(override))
  notify()
}

export function clearUserProviderOverride(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(storageKey())
  notify()
}

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Hook: the personal override, live after saves in Preferences. */
export function useUserProviderOverride(): UserProviderOverride | null {
  return useSyncExternalStore(
    (listener) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === storageKey()) listener()
      }
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
      const off = subscribe(listener)
      const offOwner = subscribeClientLocalStorageOwner(listener)
      return () => {
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
        off()
        offOwner()
      }
    },
    getUserProviderOverride,
    () => null,
  )
}
