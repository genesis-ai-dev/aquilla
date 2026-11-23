import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "fake-indexeddb/auto"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import {
  schema as offlineSchema,
  tables as offlineTables,
  events as offlineEvents,
} from "@/lib/offline/schema"
import type { CqrsRawEvent } from "./outbox-types"
import { CQRS_SCHEMA_VERSION } from "./outbox-types"

// Holds IndexedDB writes at a gate, so a test can route a second write while
// the first is decided but not yet in IndexedDB.
let gate: Promise<void> | null = null
let reachedGate: () => void = () => {}
vi.mock("./outbox-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbox-recovery")>()
  return {
    ...actual,
    addOutboxRecords: async (...args: Parameters<typeof actual.addOutboxRecords>) => {
      if (gate) {
        reachedGate()
        await gate
      }
      return actual.addOutboxRecords(...args)
    },
  }
})

let currentOfflineStore: Store<typeof offlineSchema> | undefined
vi.mock("@/lib/offline/store", () => ({
  getOfflineStore: async () => {
    if (!currentOfflineStore) throw new Error("test: offline store not initialized")
    return currentOfflineStore
  },
}))

const { enqueueOutboxEvent, enqueueOutboxEvents, peekOutboxBatch, resetOutboxConnectionForTests, setActiveOutboxOwner } =
  await import("./outbox")

const base = {
  schemaVersion: CQRS_SCHEMA_VERSION,
  projectId: "proj1",
  fileId: "file1",
  cellId: "cell1",
  author: "dev@local.test",
  clientTs: 1,
}

describe("offline routing while an earlier write is in flight", () => {
  beforeEach(async () => {
    localStorage.clear()
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
    currentOfflineStore = await createStorePromise({
      schema: offlineSchema,
      storeId: `outbox-race-test-${Math.random().toString(36).slice(2)}`,
      adapter: makeInMemoryAdapter(),
      disableDevtools: true,
      batchUpdates: (run) => run(),
    })
    currentOfflineStore.commit(offlineEvents.offlineProjectStatusSet({
      projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0,
    }))
    ;(window as unknown as { __TAURI__?: object }).__TAURI__ = {}
    setActiveOutboxOwner("alice")
  })

  afterEach(() => {
    gate = null
    delete (window as unknown as { __TAURI__?: object }).__TAURI__
    currentOfflineStore = undefined
  })

  it("keeps an edit in IndexedDB when its parent is headed there but not written yet", async () => {
    // A create can't go offline, so the commit chained on it goes to
    // IndexedDB with it.
    const create = { ...base, id: "sc1", kind: "source.cell.create", parentId: null, payload: {} } as unknown as CqrsRawEvent
    const commitA = { ...base, id: "tcA", kind: "target.cell.commit", parentId: "sc1", payload: { value: "a" } } as CqrsRawEvent
    const commitB = { ...base, id: "tcB", kind: "target.cell.commit", parentId: "tcA", payload: { value: "b" } } as CqrsRawEvent

    await peekOutboxBatch(1) // open the outbox before gating its writes
    let release: () => void = () => {}
    gate = new Promise<void>((resolve) => { release = resolve })
    const atGate = new Promise<void>((resolve) => { reachedGate = resolve })

    const first = enqueueOutboxEvents([create, commitA])
    await atGate // A is routed to IndexedDB, its write not landed
    const second = enqueueOutboxEvent(commitB)
    await new Promise((resolve) => setTimeout(resolve, 20))
    gate = null
    release()
    await Promise.all([first, second])

    // B in the offline queue could flush before A and be logged stale.
    expect(currentOfflineStore!.query(offlineTables.eventQueue.count())).toBe(0)
    expect((await peekOutboxBatch(10)).map((r) => r.id)).toEqual(["sc1", "tcA", "tcB"])
  })
})
