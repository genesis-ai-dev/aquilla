import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { schema, events } from "./schema"
import { createOfflineSyncManager } from "./sync-manager"
import type { MintToken } from "./sync-adapter"

// Minimal fake WS — these tests only care about adapter lifecycle, not wire
// traffic, so every socket just sits open with nothing driving it further.
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(_url: string) {}
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
}
const FakeWsCtor = FakeWebSocket as unknown as typeof WebSocket

async function drainMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

let store: Store<typeof schema>
let storeId = 0

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `sync-manager-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
})

const okMint: MintToken = async () => ({ token: "tok", status: null })

describe("createOfflineSyncManager", () => {
  it("starts with no adapters when nothing is marked ready", async () => {
    const manager = createOfflineSyncManager({ store, mintToken: okMint, webSocketCtor: FakeWsCtor })
    await drainMicrotasks()
    expect(manager.activeProjectIds()).toEqual([])
    manager.close()
  })

  it("opens an adapter when a project becomes ready, and closes it when removed", async () => {
    const manager = createOfflineSyncManager({ store, mintToken: okMint, webSocketCtor: FakeWsCtor })
    await drainMicrotasks()

    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    await drainMicrotasks()
    expect(manager.activeProjectIds()).toEqual(["proj1"])

    store.commit(events.offlineProjectRemoved({ projectId: "proj1" }))
    await drainMicrotasks()
    expect(manager.activeProjectIds()).toEqual([])

    manager.close()
  })

  it("does not open an adapter for a project still downloading", async () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "downloading", syncedAt: null, queueDepth: 0 }),
    )
    const manager = createOfflineSyncManager({ store, mintToken: okMint, webSocketCtor: FakeWsCtor })
    await drainMicrotasks()
    expect(manager.activeProjectIds()).toEqual([])
    manager.close()
  })

  it("reuses the same adapter across unrelated table updates instead of recreating it", async () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    const manager = createOfflineSyncManager({ store, mintToken: okMint, webSocketCtor: FakeWsCtor })
    await drainMicrotasks()
    expect(manager.activeProjectIds()).toEqual(["proj1"])

    // A second, unrelated offline_projects write (different project) must not
    // tear down and recreate proj1's live adapter.
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj2", status: "downloading", syncedAt: null, queueDepth: 0 }),
    )
    await drainMicrotasks()
    expect(manager.activeProjectIds()).toEqual(["proj1"])

    manager.close()
  })

  it("closes every adapter on close()", async () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj2", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    const manager = createOfflineSyncManager({ store, mintToken: okMint, webSocketCtor: FakeWsCtor })
    await drainMicrotasks()
    expect(manager.activeProjectIds().sort()).toEqual(["proj1", "proj2"])

    manager.close()
    expect(manager.activeProjectIds()).toEqual([])

    // Further table changes after close() must not resurrect an adapter.
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj3", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    await drainMicrotasks()
    expect(manager.activeProjectIds()).toEqual([])
  })
})

describe("mintToken wiring", () => {
  it("passes the manager's mintToken through to each project's adapter", async () => {
    const mintToken = vi.fn(okMint)
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    const manager = createOfflineSyncManager({ store, mintToken, webSocketCtor: FakeWsCtor })
    await drainMicrotasks()
    expect(mintToken).toHaveBeenCalledWith("proj1", "file1")
    manager.close()
  })
})
