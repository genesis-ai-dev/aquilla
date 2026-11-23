// Boots the local LiveStore SQLite store used to hold offline project data in
// the Tauri desktop app. Only valid inside the Tauri WebView (OPFS + a
// dedicated leader worker) — the plain browser SPA has no use for this
// and keeps reading through sync-worker HTTP (see src/lib/sync/*-read.ts).
import { createStorePromise, type Adapter, type Store } from "@livestore/livestore"
import { unstable_batchedUpdates as batchUpdates } from "react-dom"
import { schema } from "./schema"
import { isTauriRuntime } from "./is-tauri"
import { installBfcacheGuard, trackLeaderWorker } from "./bfcache-guard"
import { checkClientSessionHead } from "./head-check"
import { startLocalCheckpoints } from "./local-checkpoint"
import { claimOfflineGeneration, opfsGenerationMarker, type GenerationMarker } from "./generation-guard"
import { listenForOfflineRebuildProgress } from "./boot-progress"
import { listenForLeaderWarnings } from "./leader-warnings"
import { OfflineLeaderBootError } from "./leader-boot-error"
import { STORE_ID } from "./store-id"

export { STORE_ID }

// Re-exported for backward compatibility — existing importers (e.g.
// OfflineStoreContext.tsx) pull isTauriRuntime from here. New callers outside
// src/lib/offline/ that only need the runtime check (no LiveStore boot)
// should import it from ./is-tauri directly to avoid the heavier bundle.
export { isTauriRuntime }

/** Injection seam for tests — production boots the real leader worker (single-tab adapter). */
export type CreateOfflineAdapter = () => Adapter | Promise<Adapter>

const defaultCreateAdapter: CreateOfflineAdapter = async () => {
  // AQU-2091: imported here, not at the top. Importing @livestore/adapter-web
  // starts downloading and compiling its 605 KB SQLite engine immediately
  // (sqlite-loader.js kicks it off at module load), and a top-level import put
  // that on every browser visit, though only the desktop app ever boots a store.
  const [{ makeSingleTabAdapter }, { default: LiveStoreWorker }] = await Promise.all([
    import("@livestore/adapter-web"),
    import("./livestore.worker?worker"),
  ])
  const devBridge = import.meta.env.DEV ? await import("./leader-log-bridge") : null
  devBridge?.installLeaderLogCollector()
  installBfcacheGuard()
  listenForLeaderWarnings()
  // Before the leader boots, so a rebuild's progress is caught from the start (see boot-progress.ts).
  listenForOfflineRebuildProgress()
  // Single-tab, not makePersistedAdapter: that one relays every session ↔
  // leader message through a SharedWorker, and WKWebView hosts SharedWorkers
  // in a separate WebContent process that it kills under memory pressure
  // ("Suspended WebProcess is exiting due to memory pressure", 2026-11-17,
  // during a project download). It starts a fresh SharedWorker that no
  // leader is attached to, so every later write lands only in the page's
  // memory — lost on restart. The desktop app has one window, so the page
  // talks to its own leader worker directly. Same worker, OPFS files and
  // clientId as before. Cost: the LiveStore devtools need the SharedWorker,
  // so they don't connect in dev builds either (the adapter forces them off).
  //
  // makeSingleTabAdapter takes no lock, so the worker takes the one
  // makePersistedAdapter used to, and waits out a previous page's leader
  // before it touches the OPFS files (see leader-lock.ts).
  return makeSingleTabAdapter({
    worker: (options: { name: string }) => {
      const worker = new LiveStoreWorker(options)
      trackLeaderWorker(worker)
      failBootOnLeaderError(worker)
      devBridge?.watchLeaderWorker(worker, options.name)
      return worker
    },
    storage: { type: "opfs" },
    // The fast path reads the state db straight from OPFS, in parallel with
    // the leader's boot. After an offline schema change the leader is
    // rebuilding that file from the eventlog (minutes on a big store), and a
    // session booted from the half-built file saw a ready project as
    // `downloading` — recoverInterruptedDownloads then deleted it (found
    // 2026-10-15). Taking the snapshot from the leader waits for its boot,
    // rebuild included. A leader that never boots now never hands out a
    // store either; OfflineLeaderWatchdog prompts a restart if boot drags on.
    experimental: { disableFastPath: true },
  })
}

let storePromise: Promise<Store<typeof schema>> | undefined

// A leader that stops before the store opens (livestore.worker.ts) fires
// `error` on its Worker, and the adapter calls LiveStore's shutdown, but in
// LiveStore 0.4.0 that never fails createStorePromise: shutdown closes the
// store's lifetime scope while the boot runs in another one, so the boot
// waited forever (seen on device, 2026-11-18). So the boot watches the
// leader's `error` event itself. Set only while createStorePromise is in
// flight: once the store is open, a leader error mustn't reject a store that's
// already out there (head-check and checkpoints are still to run).
let failBoot: ((error: OfflineLeaderBootError) => void) | undefined

/**
 * Fails the boot in flight, if any, when `worker` reports an uncaught error.
 * Every such error is fatal to the leader: the runner closes on it. After the
 * store is out, a dead leader is the stall watchdog's to report instead.
 */
export function failBootOnLeaderError(worker: EventTarget & { terminate?: () => void }): void {
  worker.addEventListener("error", (event) => {
    if (!failBoot) return
    const reason = event instanceof ErrorEvent && event.message ? event.message : "unknown error"
    failBoot(new OfflineLeaderBootError(`[offline] the leader stopped before the store opened: ${reason}`))
    // Its runner has closed; nothing will talk to it again.
    worker.terminate?.()
  })
}

let markVerified: () => void = () => {}
let verified = new Promise<void>((resolve) => {
  markVerified = resolve
})

/**
 * Resolves once the leader has confirmed the session's view of the store
 * (head-check "ok"), which may be long after getOfflineStore() resolved: on a
 * timeout the store is handed out unverified so the watchdog can surface a
 * dead leader. Never resolves for a store that's inconsistent. Anything that
 * deletes local data on the strength of what it reads must wait for this.
 */
export function whenOfflineStoreVerified(): Promise<void> {
  return verified
}

/** Boots (once) and returns the offline store. Memoized — repeat calls return the same promise/instance. */
export function getOfflineStore(
  createAdapter: CreateOfflineAdapter = defaultCreateAdapter,
  generationMarker: GenerationMarker = opfsGenerationMarker,
): Promise<Store<typeof schema>> {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error("getOfflineStore() is only available in the Tauri desktop app"))
  }
  storePromise ??= bootOfflineStore(createAdapter, generationMarker)
  return storePromise
}

function bootOfflineStore(
  createAdapter: CreateOfflineAdapter,
  generationMarker: GenerationMarker,
): Promise<Store<typeof schema>> {
  const bootStartedAt = performance.now()
  // Claim before boot: a newer build that crashes mid-boot may already have written.
  return claimOfflineGeneration(generationMarker)
    .then(() => createAdapter())
    .then(openStore)
    .then(async (store) => {
      // A stale client session must not take writes; hold the store back
      // while the page reloads (see head-check.ts).
      const headCheck = await checkClientSessionHead(store, {
        onVerdict: (result) => {
          if (result === "ok") markVerified()
        },
      })
      if (headCheck === "reloading") return new Promise<never>(() => {})
      startLocalCheckpoints(store)
      if (import.meta.env.DEV) console.info(`[offline] store ready in ${Math.round(performance.now() - bootStartedAt)} ms`)
      return store
    })
}

/**
 * createStorePromise, failed by a leader that stops before the store opens
 * (see failBoot). On that failure the abandoned boot's scope is closed through
 * its signal, so its in-memory SQLite and channels don't sit pending forever.
 */
function openStore(adapter: Adapter): Promise<Store<typeof schema>> {
  const abandon = new AbortController()
  const leaderFailed = new Promise<never>((_, reject) => {
    failBoot = reject
  })
  return Promise.race([
    createStorePromise({ schema, storeId: STORE_ID, adapter, batchUpdates, signal: abandon.signal }),
    leaderFailed,
  ])
    .catch((error: unknown) => {
      abandon.abort()
      throw error
    })
    .finally(() => {
      failBoot = undefined
    })
}

/** Test seam — reset the memoized store between tests. */
export function __resetOfflineStoreForTests(): void {
  storePromise = undefined
  failBoot = undefined
  verified = new Promise<void>((resolve) => {
    markVerified = resolve
  })
}
