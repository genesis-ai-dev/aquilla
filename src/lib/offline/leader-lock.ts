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
//
// The lock alone isn't enough, though. A v0.2.4 page holds it in the page, so
// on the first update from v0.2.4 it's dropped with the old document, maybe
// before the old worker has closed the files; and a holder we steal from (see
// below) may still have them open. So once it has the lock, the leader also
// waits for the files themselves to be free (opfs-handles.ts).

export const leaderLockName = (storeId: string): string => `livestore-tab-lock-${storeId}`

/** How long the leader waits for the lock before saying so. */
const SLOW_LOCK_MS = 5_000
/**
 * How long the leader waits before taking the lock from whoever holds it. A
 * holder that's been frozen or suspended (WKWebView after unload, a v0.2.4
 * page during a hot-bundle update) never lets go, and the desktop app has one
 * window, so a holder this old is a leftover. Taking the lock isn't taking
 * the files: the leader still waits for the OPFS handles to be free before it
 * boots (see opfs-handles.ts), so a holder that's still alive is never raced.
 *
 * The leader the lock is taken from stops (its lock request rejects with
 * AbortError, see livestore.worker.ts), which is what frees the files. That's
 * only safe because of the one window: with a second window or any other live
 * store user, a slow but live leader would be killed here and its page left
 * with a store whose writes go nowhere. Remove the steal before adding one.
 */
const STEAL_LOCK_MS = 30_000

export interface HoldLeaderLockOptions {
  locks?: LockManager | undefined
  slowAfterMs?: number
  stealAfterMs?: number
  onSlow?: (waitedMs: number) => void
  onSteal?: (waitedMs: number) => void
}

/**
 * Waits for the leader lock, then runs `leader` and holds the lock until it
 * settles. Rejects if the browser has no Web Locks or the request fails, and
 * with whatever `leader` rejects with.
 *
 * A wait that drags on is reported, and one that drags on past
 * `stealAfterMs` takes the lock (`steal`) rather than waiting forever on a
 * holder that's never coming back.
 */
export async function holdLeaderLock(
  name: string,
  leader: () => Promise<void>,
  {
    locks = globalThis.navigator?.locks,
    slowAfterMs = SLOW_LOCK_MS,
    stealAfterMs = STEAL_LOCK_MS,
    onSlow = (waitedMs) => console.warn(`[offline] leader still waiting for '${name}' after ${waitedMs} ms — another leader holds the OPFS files`),
    onSteal = (waitedMs) => console.warn(`[offline] leader took '${name}' after waiting ${waitedMs} ms — its holder never let go`),
  }: HoldLeaderLockOptions = {},
): Promise<void> {
  if (!locks) throw new Error("The offline store needs the Web Locks API (navigator.locks)")
  let granted = false
  const run = () => {
    granted = true
    clearTimeout(slow)
    clearTimeout(steal)
    return leader()
  }
  const giveUp = new AbortController()
  const slow = setTimeout(() => onSlow(slowAfterMs), slowAfterMs)
  const steal = setTimeout(() => giveUp.abort(), stealAfterMs)
  try {
    await locks.request(name, { signal: giveUp.signal }, run)
  } catch (error) {
    // Only a wait we gave up on is retried; the leader's own errors pass through.
    if (granted || !giveUp.signal.aborted) throw error
    onSteal(stealAfterMs)
    await locks.request(name, { steal: true }, run)
  } finally {
    clearTimeout(slow)
    clearTimeout(steal)
  }
}
