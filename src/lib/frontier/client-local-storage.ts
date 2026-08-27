/**
 * Account boundary for browser-local values that must survive account switches
 * without becoming visible to the next identity on the same origin.
 *
 * `undefined` is the short pre-hydration/upgrade state. The account provider
 * publishes either an account key or `null` (local-only mode) before rendering
 * account-scoped routes.
 */
let activeOwnerKey: string | null | undefined
const ownerListeners = new Set<() => void>()

function notifyOwnerChange(): void {
  for (const listener of ownerListeners) {
    try { listener() } catch {
      // A best-effort UI subscriber must not abort the account boundary and
      // leave React identity paired with a partially switched storage scope.
    }
  }
}

const LEGACY_EXACT_KEYS = new Set([
  "aquilla:translatorProfile",
  "aquilla:userProviderOverride",
])
const LEGACY_PREFIXES = [
  "frontier:user-api-key:",
  "frontier:project-tts:",
  "comment-draft:",
  "bt:",
]

function isAlreadyScoped(key: string): boolean {
  return key.startsWith("owner:local:") || key.startsWith("owner:account:")
}

function isOwnedLegacyKey(key: string): boolean {
  if (isAlreadyScoped(key)) return false
  return LEGACY_EXACT_KEYS.has(key) || LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function ownerScopedLocalStorageKey(legacyKey: string): string {
  if (activeOwnerKey === undefined) return legacyKey
  const owner = activeOwnerKey === null
    ? "local"
    : `account:${encodeURIComponent(activeOwnerKey)}`
  return `owner:${owner}:${legacyKey}`
}

/** Set synchronously before React publishes the matching account identity. */
export function setClientLocalStorageOwner(ownerKey: string | null): void {
  if (activeOwnerKey === ownerKey) return
  activeOwnerKey = ownerKey
  notifyOwnerChange()
}

export function subscribeClientLocalStorageOwner(listener: () => void): () => void {
  ownerListeners.add(listener)
  return () => ownerListeners.delete(listener)
}

/**
 * One-time upgrade bridge. The first resolved owner receives legacy values;
 * deleting each source prevents a later account from claiming the same data.
 * Existing scoped values win if a write raced migration.
 */
export function claimLegacyClientLocalStorage(ownerKey: string | null): void {
  if (typeof localStorage === "undefined") return
  try {
    const legacyKeys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && isOwnedLegacyKey(key)) legacyKeys.push(key)
    }

    for (const legacyKey of legacyKeys) {
      const value = localStorage.getItem(legacyKey)
      const owner = ownerKey === null ? "local" : `account:${encodeURIComponent(ownerKey)}`
      const targetKey = `owner:${owner}:${legacyKey}`
      if (value !== null && localStorage.getItem(targetKey) === null) {
        localStorage.setItem(targetKey, value)
      }
      localStorage.removeItem(legacyKey)
    }
    if (legacyKeys.length > 0) {
      notifyOwnerChange()
    }
  } catch {
    // Disabled/full storage cannot expose legacy values through scoped readers;
    // preserving route availability is preferable to blocking sign-in on a
    // best-effort browser-local migration.
  }
}

/** Reset module state without notifying consumers (focused tests only). */
export function resetClientLocalStorageOwnerForTests(): void {
  activeOwnerKey = undefined
  ownerListeners.clear()
}
