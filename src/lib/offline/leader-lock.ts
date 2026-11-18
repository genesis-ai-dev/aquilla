// The Web Lock that keeps two LiveStore leaders off the same OPFS files.
//
// makeSingleTabAdapter (store.ts) takes no lock of its own, so the leader
// worker (livestore.worker.ts) takes one before it boots. A reloaded page
// (head-check, bfcache guard, bundle update) must not start its leader while
// the old one still holds the OPFS access handles: the new leader's
// `#acquireAccessHandles` fails with InvalidStateError and has no retry.
//
// The worker holds the lock, not the page, because the worker holds the
// handles. The browser drops a worker's locks when the worker dies, so the lock
// is freed when the handles are: on a graceful shutdown (we release it once the
// leader has closed its databases), on `terminate()` from the bfcache guard,
// and when the page unloads. A lock held by the page was freed when the
// document went away, which could be before its worker had let go.
//
// The name is LiveStore's own (`LIVESTORE_TAB_LOCK` in adapter-web 0.4.0's
// persisted-adapter.js), not ours to pick: during a hot-bundle update the old
// page may still be running a makePersistedAdapter build, and the two leaders
// only exclude each other if both use the same name. Web Locks are shared
// across an origin's pages and workers alike. leader-lock.test.ts pins the
// name against the installed LiveStore so a version bump that renames it fails CI.

export const leaderLockName = (storeId: string): string => `livestore-tab-lock-${storeId}`

/** How long the leader waits for the lock before saying so in the console. */
const SLOW_LOCK_MS = 5_000

export interface HoldLeaderLockOptions {
  locks?: LockManager | undefined
  slowAfterMs?: number
  onSlow?: (waitedMs: number) => void
}

/**
 * Waits for the leader lock, then runs `leader` and holds the lock until it
 * settles. Rejects if the browser has no Web Locks or the request fails, and
 * with whatever `leader` rejects with.
 *
 * A wait that drags on is logged: a page that never lets go (a frozen v0.2.4
 * page during a hot-bundle update, a WKWebView leader frozen after unload)
 * otherwise looks like any other slow boot.
 */
export async function holdLeaderLock(
  name: string,
  leader: () => Promise<void>,
  {
    locks = globalThis.navigator?.locks,
    slowAfterMs = SLOW_LOCK_MS,
    onSlow = (waitedMs) => console.warn(`[offline] leader still waiting for '${name}' after ${waitedMs} ms — another leader holds the OPFS files`),
  }: HoldLeaderLockOptions = {},
): Promise<void> {
  if (!locks) throw new Error("The offline store needs the Web Locks API (navigator.locks)")
  const slow = setTimeout(() => onSlow(slowAfterMs), slowAfterMs)
  try {
    await locks.request(name, () => {
      clearTimeout(slow)
      return leader()
    })
  } finally {
    clearTimeout(slow)
  }
}
