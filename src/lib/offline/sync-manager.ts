/**
 * Keeps one OfflineSyncAdapter alive per project marked `ready` for offline
 * use. LiveStore holds every downloaded project's rows in a single store
 * (per the Phase 1 design — "one store holds all downloaded projects'
 * rows"), so staying in sync means watching `offline_projects` for
 * membership changes, not just whichever project a route happens to have
 * open: a background project must keep receiving upstream commits (and
 * flushing its own queued writes) even while the user is looking at a
 * different one.
 *
 * Project Download UI (Phase 5) is what will actually populate
 * `offline_projects` with `status: "ready"` rows; this manager only reacts
 * to that table, so it's inert (zero adapters) until Phase 5 ships.
 */
import type { Store } from "@livestore/livestore"
import { tables, type schema } from "./schema"
import { createOfflineSyncAdapter, type MintToken, type OfflineSyncAdapter } from "./sync-adapter"

export interface OfflineSyncManagerOptions {
  store: Store<typeof schema>
  mintToken: MintToken
  baseUrl?: string
  fetchImpl?: typeof fetch
  webSocketCtor?: typeof WebSocket
  minBackoffMs?: number
  maxBackoffMs?: number
}

export interface OfflineSyncManager {
  /** Currently managed project ids — test/debug visibility. */
  activeProjectIds(): string[]
  close(): void
}

export function createOfflineSyncManager(options: OfflineSyncManagerOptions): OfflineSyncManager {
  const { store } = options
  const adapters = new Map<string, OfflineSyncAdapter>()
  let closed = false

  function reconcile(): void {
    if (closed) return
    const readyIds = new Set(
      store.query(tables.offlineProjects.select().where({ status: "ready" })).map((r) => r.projectId),
    )
    for (const [projectId, adapter] of adapters) {
      if (readyIds.has(projectId)) continue
      adapter.close()
      adapters.delete(projectId)
    }
    for (const projectId of readyIds) {
      if (adapters.has(projectId)) continue
      adapters.set(
        projectId,
        createOfflineSyncAdapter({
          projectId,
          store,
          mintToken: options.mintToken,
          baseUrl: options.baseUrl,
          fetchImpl: options.fetchImpl,
          webSocketCtor: options.webSocketCtor,
          minBackoffMs: options.minBackoffMs,
          maxBackoffMs: options.maxBackoffMs,
        }),
      )
    }
  }

  reconcile()
  const unsubscribe = store.subscribe(tables.offlineProjects.select(), reconcile)

  return {
    activeProjectIds: () => [...adapters.keys()],
    close(): void {
      closed = true
      unsubscribe()
      for (const adapter of adapters.values()) adapter.close()
      adapters.clear()
    },
  }
}
