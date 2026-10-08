// Boots the local LiveStore SQLite store used to hold offline project data in
// the Tauri desktop app. Only valid inside the Tauri WebView (OPFS + a
// SharedWorker leader election) — the plain browser SPA has no use for this
// and keeps reading through sync-worker HTTP (see src/lib/sync/*-read.ts).
import { makePersistedAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Adapter, type Store } from "@livestore/livestore"
import { unstable_batchedUpdates as batchUpdates } from "react-dom"
import { schema } from "./schema"
import { isTauriRuntime } from "./is-tauri"
import { installBfcacheGuard, trackLeaderWorker } from "./bfcache-guard"
import { checkClientSessionHead } from "./head-check"
import { claimOfflineGeneration, opfsGenerationMarker, type GenerationMarker } from "./generation-guard"

// Names the OPFS directory the store lives in — changing it strands every
// device's existing data (incl. unsent edits). eventlog-compat.test.ts pins it.
export const STORE_ID = "aquilla-offline"

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
  const devBridge = import.meta.env.DEV ? await import("./leader-log-bridge") : null
  devBridge?.installLeaderLogCollector()
  installBfcacheGuard()
  return makePersistedAdapter({
    worker: (options: WorkerOptions) => {
      const worker = new LiveStoreWorker(options)
      trackLeaderWorker(worker)
      devBridge?.watchLeaderWorker(worker, options.name ?? "leader")
      return worker
    },
    sharedWorker: LiveStoreSharedWorker,
    storage: { type: "opfs" },
  })
}

let storePromise: Promise<Store<typeof schema>> | undefined

/** Boots (once) and returns the offline store. Memoized — repeat calls return the same promise/instance. */
export function getOfflineStore(
  createAdapter: CreateOfflineAdapter = defaultCreateAdapter,
  generationMarker: GenerationMarker = opfsGenerationMarker,
): Promise<Store<typeof schema>> {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error("getOfflineStore() is only available in the Tauri desktop app"))
  }
  // Claim before boot: a newer build that crashes mid-boot may already have written.
  storePromise ??= claimOfflineGeneration(generationMarker)
    .then(() => createAdapter())
    .then((adapter) => createStorePromise({ schema, storeId: STORE_ID, adapter, batchUpdates }))
    .then(async (store) => {
      // A stale client session must not take writes; hold the store back
      // while the page reloads (see head-check.ts).
      if ((await checkClientSessionHead(store)) === "reloading") return new Promise<never>(() => {})
      return store
    })
  return storePromise
}

/** Test seam — reset the memoized store between tests. */
export function __resetOfflineStoreForTests(): void {
  storePromise = undefined
}
