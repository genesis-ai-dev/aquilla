// Graceful-shutdown handshake for the offline LiveStore, driven by
// src-tauri/src/shutdown_guard.rs: Rust holds up the real window
// close/app quit until this resolves, so `store.commit()`'s async hop to
// the leader worker (and therefore OPFS) has a chance to finish before the
// process dies.
//
// Why this is needed: `store.commit()` returns before the write reaches the
// leader/OPFS (confirmed empirically — a commit immediately followed by an
// unguarded reload silently vanishes, no error). `store.shutdownPromise()`
// alone does NOT wait for that either. The only reliable signal is
// `store.syncStatus().isSynced` (`pendingCount === 0` — all local commits
// pushed to the leader), which must be awaited before shutting down.
import type { Store } from "@livestore/livestore"
import type { schema } from "./schema"

const DEFAULT_TIMEOUT_MS = 5000

/**
 * Resolves once every locally committed event has reached the leader
 * thread (`store.syncStatus().isSynced`), or after `timeoutMs` — bounded so
 * a stuck leader can never hang app close indefinitely.
 */
export function waitForOfflineStoreSynced(store: Store<typeof schema>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (store.syncStatus().isSynced) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsub()
      resolve()
    }
    const unsub = store.subscribeSyncStatus((status) => {
      if (status.isSynced) finish()
    })
    const timer = setTimeout(finish, timeoutMs)
  })
}

/**
 * Waits for pending local writes to reach the leader, then shuts the store
 * down cleanly (releases its OPFS lock) so the next launch can read
 * persisted data without racing a torn-down leader for it. Total time is
 * bounded by `timeoutMs` (applied to the sync wait only — `shutdownPromise`
 * itself is fast once nothing is pending).
 */
export async function shutdownOfflineStoreGracefully(store: Store<typeof schema>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await waitForOfflineStoreSynced(store, timeoutMs)
  await store.shutdownPromise()
}
