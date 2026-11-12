// Origin storage pressure: one place that knows whether this browser origin is
// close to its quota, and the one helper that recognises a quota failure.
//
// AQU-1865. Every durable store this app owns — the cells cache, the audio
// caches, the OPFS blobs and, critically, the CQRS **outbox** — shares a single
// origin quota. The outbox is the only one that is not best-effort: a cache miss
// costs a refetch, but an outbox write that fails loses a contributor's edit.
// So quota is treated as a resource the caches must yield to the outbox:
//
//   1. request persistent storage once, so the browser stops evicting us first;
//   2. recognise `QuotaExceededError` wherever it surfaces (`isQuotaExceededError`);
//   3. let a store that hit it publish the pressure (`markStorageQuotaExceeded`)
//      so the UI can warn, while the store itself sheds cache bytes and retries.
//
// Mirrors `opfs-availability.ts`: a tiny module-level store with
// `useSyncExternalStore` subscribers, no React import, test seam at the bottom.

/** Fraction of the granted quota at which we warn the user. */
export const STORAGE_NEARLY_FULL_RATIO = 0.9

type Listener = (nearlyFull: boolean) => void

let _nearlyFull = false
const listeners = new Set<Listener>()

/**
 * True when a quota error has been seen, or the last estimate put us over
 * `STORAGE_NEARLY_FULL_RATIO` of the granted quota.
 */
export function isStorageNearlyFull(): boolean {
  return _nearlyFull
}

export function subscribeStoragePressure(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function publish(nearlyFull: boolean): void {
  if (_nearlyFull === nearlyFull) return
  _nearlyFull = nearlyFull
  for (const fn of listeners) fn(nearlyFull)
}

/**
 * A durable write just failed for want of space. Latches the warning on: an
 * estimate taken right after an eviction can read comfortable again, and the
 * user still needs to know their disk is the reason loads got slower.
 */
export function markStorageQuotaExceeded(): void {
  publish(true)
}

/**
 * `QuotaExceededError` as the browsers actually throw it. Chrome/Safari raise a
 * `DOMException` with that `name`; Firefox's IndexedDB historically surfaced the
 * legacy `NS_ERROR_DOM_QUOTA_REACHED` name with the same code 22.
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const { name, code } = error as { name?: unknown; code?: unknown }
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  return code === 22
}

/**
 * Re-read `navigator.storage.estimate()` and publish the result. Never throws:
 * the API is absent in several of the contexts that most need the warning
 * (private browsing, locked-down profiles), and there the honest answer is
 * "unknown", not "full".
 */
export async function refreshStoragePressure(): Promise<boolean> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    const usage = estimate?.usage
    const quota = estimate?.quota
    if (
      typeof usage !== "number" || !Number.isFinite(usage)
      || typeof quota !== "number" || !Number.isFinite(quota) || quota <= 0
    ) {
      return _nearlyFull
    }
    // Never clears a latched quota error: `markStorageQuotaExceeded` is a fact
    // about a write that failed, which a later roomy estimate does not undo.
    if (usage / quota >= STORAGE_NEARLY_FULL_RATIO) publish(true)
  } catch {
    /* unknown — leave the current state alone */
  }
  return _nearlyFull
}

/**
 * Run a durable write, reclaiming space once if the browser says there is none.
 *
 * The shape every caller needs: attempt, and on `QuotaExceededError` publish the
 * pressure, let `reclaim` free bytes, then attempt exactly once more. A second
 * quota failure propagates — there is nothing left to try, and swallowing it
 * would hide a lost write. Any other error propagates immediately without
 * reclaiming: a schema or transaction bug must not cost the user their caches.
 */
export async function withStorageQuotaRecovery(
  write: () => Promise<void>,
  reclaim: () => Promise<void>,
): Promise<void> {
  try {
    await write()
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error
    markStorageQuotaExceeded()
    await reclaim()
  }
  await write()
}

let persistPromise: Promise<boolean> | null = null

/**
 * Ask for persistent storage once per session. Granted, the browser stops
 * evicting this origin under disk pressure — which is what keeps a queued
 * outbox edit alive on a machine that fills up overnight. Chrome grants it
 * silently on an installed/engaged origin; Safari ignores it; a denial is not
 * an error and changes nothing about how the app behaves.
 */
export function requestPersistentStorage(): Promise<boolean> {
  if (persistPromise) return persistPromise
  persistPromise = (async () => {
    try {
      const storage = navigator.storage
      if (!storage?.persist) return false
      if (await storage.persisted?.()) return true
      return await storage.persist()
    } catch {
      return false
    }
  })()
  return persistPromise
}

/** Test seam — reset back to "roomy, never asked". */
export function __resetStoragePressureForTests(): void {
  _nearlyFull = false
  listeners.clear()
  persistPromise = null
}
