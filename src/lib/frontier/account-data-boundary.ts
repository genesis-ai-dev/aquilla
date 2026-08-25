import { purgeAudioCachesOnSignOut } from "@/lib/audio/cache-cleanup"
import {
  claimLegacyFileProgressCache,
  setFileProgressCacheOwner,
} from "@/lib/progress/file-progress-resource"
import { claimLegacyCellsCache, setCellsCacheOwner } from "@/lib/sync/cells-cache"
import { claimLegacyOutboxEvents, setActiveOutboxOwner } from "@/lib/sync/outbox"
import { clearAllLocalData } from "@/lib/store/project-index"
import {
  claimLegacyClientLocalStorage,
  setClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

export const ACCOUNT_DATA_CLEANUP_TIMEOUT_MS = 5_000

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not finish`)),
      ACCOUNT_DATA_CLEANUP_TIMEOUT_MS,
    )
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Publish the storage namespace that belongs to the same identity React is
 * about to expose. Owner-scoped caches remain available when switching back,
 * but can never be read by a different account.
 */
export async function activateClientDataScope(
  ownerKey: string | null,
  options: { claimLegacy?: boolean } = {},
): Promise<void> {
  setCellsCacheOwner(ownerKey)
  setFileProgressCacheOwner(ownerKey)
  setActiveOutboxOwner(ownerKey)
  setClientLocalStorageOwner(ownerKey)
  if (options.claimLegacy) {
    // `dataOwner === undefined` is the one-time upgrade authority. Claim every
    // previously unscoped durable store before publishing the first resolved
    // owner, including local-only mode. Deleting the legacy keys during each
    // claim prevents a later account from seeing the same snapshots.
    claimLegacyClientLocalStorage(ownerKey)
    await Promise.all([
      withTimeout(claimLegacyOutboxEvents(ownerKey), "Legacy outbox migration"),
      withTimeout(claimLegacyCellsCache(ownerKey), "Legacy cells cache migration"),
      withTimeout(claimLegacyFileProgressCache(ownerKey), "Legacy progress cache migration"),
    ])
  }
}

/**
 * Remove stores that cannot be safely namespaced. Failure is security-relevant:
 * the caller must keep the route behind its neutral transition boundary and
 * offer retry instead of publishing the next identity over stale data.
 */
export async function clearPreviousAccountData(): Promise<void> {
  await Promise.all([
    withTimeout(clearAllLocalData(), "Project cache cleanup"),
    withTimeout(purgeAudioCachesOnSignOut({ strict: true }), "Audio cache cleanup"),
  ])
  clearLegacyAgentSessions()
}

function clearLegacyAgentSessions(): void {
  if (typeof localStorage === "undefined") return
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith("aquilla:agent-session:v1:")) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // Account-scoped v2 keys are the live store. Legacy removal is migration
    // hygiene only and localStorage may be disabled in private mode.
  }
}
