import { describe, it, expect, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { schema, type schema as SchemaType } from "./schema"
import { waitForOfflineStoreSynced, shutdownOfflineStoreGracefully } from "./shutdown"

let storeId = 0

async function makeRealStore() {
  storeId += 1
  return createStorePromise({
    schema,
    storeId: `shutdown-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
}

type FakeSyncStatus = { isSynced: boolean; pendingCount: number; localHead: string; upstreamHead: string }

function makeFakeStore(overrides: {
  syncStatus: () => FakeSyncStatus
  subscribeSyncStatus: (onUpdate: (status: FakeSyncStatus) => void) => () => void
  shutdownPromise?: () => Promise<void>
}) {
  return {
    syncStatus: overrides.syncStatus,
    subscribeSyncStatus: overrides.subscribeSyncStatus,
    shutdownPromise: overrides.shutdownPromise ?? vi.fn(async () => {}),
  } as unknown as Store<typeof SchemaType>
}

describe("waitForOfflineStoreSynced", () => {
  it("resolves immediately when an idle real store is already synced", async () => {
    const store = await makeRealStore()
    await expect(waitForOfflineStoreSynced(store, 1000)).resolves.toBeUndefined()
  })

  it("resolves once subscribeSyncStatus reports isSynced, and unsubscribes", async () => {
    let handler: ((status: FakeSyncStatus) => void) | undefined
    const unsub = vi.fn()
    const store = makeFakeStore({
      syncStatus: () => ({ isSynced: false, pendingCount: 1, localHead: "e0", upstreamHead: "e0" }),
      subscribeSyncStatus: (cb) => {
        handler = cb
        return unsub
      },
    })

    const promise = waitForOfflineStoreSynced(store, 5000)
    handler?.({ isSynced: true, pendingCount: 0, localHead: "e1", upstreamHead: "e1" })
    await expect(promise).resolves.toBeUndefined()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it("gives up and resolves anyway once the timeout elapses", async () => {
    vi.useFakeTimers()
    try {
      const unsub = vi.fn()
      const store = makeFakeStore({
        syncStatus: () => ({ isSynced: false, pendingCount: 1, localHead: "e0", upstreamHead: "e0" }),
        subscribeSyncStatus: () => unsub,
      })

      const promise = waitForOfflineStoreSynced(store, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(promise).resolves.toBeUndefined()
      expect(unsub).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("shutdownOfflineStoreGracefully", () => {
  it("waits for sync before calling shutdownPromise", async () => {
    const shutdownPromise = vi.fn(async () => {})
    const store = makeFakeStore({
      syncStatus: () => ({ isSynced: true, pendingCount: 0, localHead: "e0", upstreamHead: "e0" }),
      subscribeSyncStatus: () => () => {},
      shutdownPromise,
    })

    await shutdownOfflineStoreGracefully(store, 1000)
    expect(shutdownPromise).toHaveBeenCalledTimes(1)
  })

  it("still calls shutdownPromise after a sync-wait timeout", async () => {
    vi.useFakeTimers()
    try {
      const shutdownPromise = vi.fn(async () => {})
      const store = makeFakeStore({
        syncStatus: () => ({ isSynced: false, pendingCount: 3, localHead: "e0", upstreamHead: "e0" }),
        subscribeSyncStatus: () => () => {},
        shutdownPromise,
      })

      const promise = shutdownOfflineStoreGracefully(store, 500)
      await vi.advanceTimersByTimeAsync(500)
      await promise
      expect(shutdownPromise).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
