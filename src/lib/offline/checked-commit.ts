import { StoreInternalsSymbol, type Store } from "@livestore/livestore"
import type { schema } from "./schema"

type OfflineStore = Store<typeof schema>

/** True once `store` has shut down; every query or commit on it throws from then on. */
export function isOfflineStoreShutDown(store: OfflineStore): boolean {
  return store[StoreInternalsSymbol]?.isShutdown === true
}

/**
 * Runs `commit` (one `store.commit` call) and throws if it didn't land.
 *
 * LiveStore 0.4's `commit()` only throws when the store was already shut down.
 * A failure in the commit itself (encoding an event, a materializer error) is
 * caught inside it, logged, and answered by shutting the store down, and
 * `commit()` returns as if it had worked. The failure comes before the push to
 * the leader, so nothing in the commit was persisted, and the caller can send
 * it somewhere else.
 */
export function commitOrThrow(store: OfflineStore, commit: () => void): void {
  commit()
  if (isOfflineStoreShutDown(store)) {
    throw new Error("The offline store shut down while committing; nothing in the commit was queued")
  }
}
