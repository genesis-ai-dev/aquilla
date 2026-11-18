// The Web Lock that keeps two pages' LiveStore leaders off the same OPFS files.
//
// makeSingleTabAdapter (store.ts) takes no lock of its own, so we take the one
// makePersistedAdapter used to take before spawning a leader. A reloaded page
// (head-check, bfcache guard, bundle update) must not start its leader while
// the old page's still holds the OPFS access handles: the new leader's
// `#acquireAccessHandles` fails with InvalidStateError and has no retry.
//
// The name is LiveStore's own (`LIVESTORE_TAB_LOCK` in adapter-web 0.4.0's
// persisted-adapter.js), not ours to pick: during a hot-bundle update the old
// page may still be running a makePersistedAdapter build, and the two leaders
// only exclude each other if both use the same name. leader-lock.test.ts pins
// it against the installed LiveStore so a version bump that renames it fails CI.
import { Effect } from "@livestore/utils/effect"
import type { Adapter } from "@livestore/livestore"

export const leaderLockName = (storeId: string): string => `livestore-tab-lock-${storeId}`

export interface LeaderLock {
  /** Resolves once this page holds the lock; rejects if the lock request fails. */
  acquired: Promise<void>
  /** Gives the lock up. Safe to call more than once, and before it was granted. */
  release: () => void
}

/**
 * Requests the lock straight away, so the wait for a departing page overlaps
 * whatever the caller does next (loading SQLite, the worker bundle). Throws if
 * the browser has no Web Locks, which the adapter needs anyway.
 */
export function requestLeaderLock(name: string, locks: LockManager | undefined = globalThis.navigator?.locks): LeaderLock {
  if (!locks) throw new Error("The offline store needs the Web Locks API (navigator.locks)")
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const acquired = new Promise<void>((granted, reject) => {
    locks
      .request(name, () => {
        granted()
        return released
      })
      .catch(reject)
  })
  return { acquired, release }
}

/**
 * Releases the lock when the store's client session shuts down, which is when
 * makePersistedAdapter released it too. Covers a graceful shutdown, a leader
 * that died and took the session with it, and an adapter that failed to boot.
 */
export function releaseLockOnShutdown(adapter: Adapter, release: () => void): Adapter {
  return (args) => Effect.addFinalizer(() => Effect.sync(release)).pipe(Effect.zipRight(adapter(args)))
}
