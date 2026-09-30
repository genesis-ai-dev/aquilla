// Boots the local LiveStore SQLite store used to hold offline project data in
// the Tauri desktop app. Only valid inside the Tauri WebView (OPFS + a
// SharedWorker leader election) — the plain browser SPA has no use for this
// and keeps reading through sync-worker HTTP (see src/lib/sync/*-read.ts).
import { makePersistedAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Adapter, type Store } from "@livestore/livestore"
import { unstable_batchedUpdates as batchUpdates } from "react-dom"
import { schema } from "./schema"
import { isTauriRuntime } from "./is-tauri"

const STORE_ID = "aquilla-offline"

// Re-exported for backward compatibility — existing importers (e.g.
// OfflineStoreContext.tsx) pull isTauriRuntime from here. New callers outside
// src/lib/offline/ that only need the runtime check (no LiveStore boot)
// should import it from ./is-tauri directly to avoid the heavier bundle.
export { isTauriRuntime }

/** Injection seam for tests — production boots the real worker + shared worker pair. */
export type CreateOfflineAdapter = () => Adapter | Promise<Adapter>

const defaultCreateAdapter: CreateOfflineAdapter = async () => {
  const [{ default: LiveStoreWorker }, { default: LiveStoreSharedWorker }] = await Promise.all([
    import("./livestore.worker?worker"),
    import("@livestore/adapter-web/shared-worker?sharedworker"),
  ])
  return makePersistedAdapter({
    worker: LiveStoreWorker,
    sharedWorker: LiveStoreSharedWorker,
    storage: { type: "opfs" },
  })
}

let storePromise: Promise<Store<typeof schema>> | undefined

/** Boots (once) and returns the offline store. Memoized — repeat calls return the same promise/instance. */
export function getOfflineStore(createAdapter: CreateOfflineAdapter = defaultCreateAdapter): Promise<Store<typeof schema>> {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error("getOfflineStore() is only available in the Tauri desktop app"))
  }
  storePromise ??= Promise.resolve(createAdapter()).then((adapter) =>
    createStorePromise({ schema, storeId: STORE_ID, adapter, batchUpdates }),
  )
  return storePromise
}

/** Test seam — reset the memoized store between tests. */
export function __resetOfflineStoreForTests(): void {
  storePromise = undefined
}
