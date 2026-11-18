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

// A dead leader: commits apply in the page's memory but are never confirmed
// as persisted. The in-memory adapter's leader is always healthy, so the
// confirmation is what this switches off.
// `reviveLeader` confirms everything a dead leader was sitting on.
let leaderDead = false
let deadLeaderWaiters: Array<() => void> = []
const reviveLeader = () => {
  leaderDead = false
  const waiters = deadLeaderWaiters
  deadLeaderWaiters = []
  for (const onPersisted of waiters) onPersisted()
}
vi.mock("@/lib/offline/leader-watchdog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/offline/leader-watchdog")>()
  return {
    ...actual,
    watchLeaderPersisted: (...args: Parameters<typeof actual.watchLeaderPersisted>) => {
      if (!leaderDead) return actual.watchLeaderPersisted(...args)
      const onPersisted = args[2]
      deadLeaderWaiters.push(onPersisted)
      return () => {
        deadLeaderWaiters = deadLeaderWaiters.filter((waiter) => waiter !== onPersisted)
      }
    },
  }
})

let failIndexedDbWrites = false
vi.mock("./outbox-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbox-recovery")>()
  return {
    ...actual,
    addOutboxRecords: async (...args: Parameters<typeof actual.addOutboxRecords>) => {
      if (failIndexedDbWrites) throw new Error("test: IndexedDB write failed")
      return actual.addOutboxRecords(...args)
    },
  }
})

let currentOfflineStore: Store<typeof offlineSchema> | undefined
let onGetOfflineStore: (() => void) | undefined
vi.mock("@/lib/offline/store", () => ({
  getOfflineStore: async () => {
    onGetOfflineStore?.()
    if (!currentOfflineStore) throw new Error("test: offline store not initialized")
    return currentOfflineStore
  },
}))

const {
  enqueueOutboxEvent,
  enqueueOutboxEvents,
  peekOutboxBatch,
  rescueUnpersistedOfflineWrites,
  resetOutboxConnectionForTests,
  setActiveOutboxOwner,
} = await import("./outbox")
const { offlineQueueWaitingIds } = await import("./offline-routing")
const { forgetStallRescueForTests, isRescuedFromOfflineQueue } = await import("./offline-stall-rescue")
const { forgetInFlightJournalForTests } = await import("./outbox-recovery")
const { setLeaderStalled, __resetLeaderStalledForTests } = await import("@/lib/offline/leader-watchdog")

const base = {
  schemaVersion: CQRS_SCHEMA_VERSION,
  projectId: "proj1",
  fileId: "file1",
  cellId: "cell1",
  author: "dev@local.test",
  clientTs: 1,
}
const commit = (id: string, parentId: string | null): CqrsRawEvent =>
  ({ ...base, id, kind: "target.cell.commit", parentId, payload: { value: id } }) as CqrsRawEvent

const journalLeft = () =>
  Object.keys(localStorage).filter((key) => key.startsWith("aquilla:outbox-recovery"))
const queuedOffline = () =>
  currentOfflineStore!.query(offlineTables.eventQueue.select("id"))
const inIndexedDb = async () => (await peekOutboxBatch(50)).map((r) => r.id)

describe("offline queue fail-safe when the leader stalls", () => {
  beforeEach(async () => {
    localStorage.clear()
    forgetInFlightJournalForTests()
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
    currentOfflineStore = await createStorePromise({
      schema: offlineSchema,
      storeId: `outbox-stall-test-${Math.random().toString(36).slice(2)}`,
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
    leaderDead = false
    deadLeaderWaiters = []
    failIndexedDbWrites = false
    onGetOfflineStore = undefined
    forgetStallRescueForTests()
    __resetLeaderStalledForTests()
    delete (window as unknown as { __TAURI__?: object }).__TAURI__
    currentOfflineStore = undefined
  })

  it("clears a routed edit's journal entry once the leader has persisted it", async () => {
    await enqueueOutboxEvent(commit("tc1", "p0"))
    expect(queuedOffline()).toEqual(["tc1"])
    await vi.waitFor(() => expect(journalLeft()).toEqual([]))
  })

  it("keeps the journal entry while the leader hasn't persisted the edit", async () => {
    leaderDead = true
    await enqueueOutboxEvent(commit("tc1", "p0"))
    await enqueueOutboxEvents([commit("tc2", "tc1"), commit("tc3", "tc2")])
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(queuedOffline()).toEqual(["tc1", "tc2", "tc3"])
    // A page that dies now still has them to replay on the next launch.
    expect(journalLeft()).toHaveLength(2)
    expect(await inIndexedDb()).toEqual([])
  })

  it("on a stall, copies what the leader never persisted to IndexedDB and lets go of the journal", async () => {
    leaderDead = true
    await enqueueOutboxEvent(commit("tc1", "p0"))
    await enqueueOutboxEvents([commit("tc2", "tc1"), commit("tc3", "tc2")])

    setLeaderStalled(true)
    expect(await rescueUnpersistedOfflineWrites()).toBe(true)

    expect(await inIndexedDb()).toEqual(["tc1", "tc2", "tc3"])
    expect(journalLeft()).toEqual([])
    // Still in the page's dead queue, but the HTTP flusher mustn't wait on them there.
    expect(queuedOffline()).toEqual(["tc1", "tc2", "tc3"])
    expect(await offlineQueueWaitingIds()).toEqual(new Set())
    // Nothing left to rescue a second time.
    expect(await rescueUnpersistedOfflineWrites()).toBe(true)
    expect(await inIndexedDb()).toEqual(["tc1", "tc2", "tc3"])
  })

  it("sends new edits to IndexedDB while the leader is stalled", async () => {
    setLeaderStalled(true)
    await enqueueOutboxEvent(commit("tc1", "p0"))
    await enqueueOutboxEvents([commit("tc2", "tc1")])

    expect(queuedOffline()).toEqual([])
    expect(await inIndexedDb()).toEqual(["tc1", "tc2"])
    expect(journalLeft()).toEqual([])
  })

  it("sends an edit to IndexedDB when the stall is reported while routing waits on the store", async () => {
    leaderDead = true
    // Routing has already decided on the offline queue when the stall lands.
    onGetOfflineStore = () => setLeaderStalled(true)
    await enqueueOutboxEvent(commit("tc1", "p0"))

    expect(queuedOffline()).toEqual([])
    expect(await inIndexedDb()).toEqual(["tc1"])
    expect(journalLeft()).toEqual([])
  })

  it("keeps the journal entry when the copy to IndexedDB fails", async () => {
    leaderDead = true
    await enqueueOutboxEvent(commit("tc1", "p0"))
    failIndexedDbWrites = true

    setLeaderStalled(true)
    expect(await rescueUnpersistedOfflineWrites()).toBe(false)
    expect(journalLeft()).toEqual(["aquilla:outbox-recovery:v1:tc1"])
    expect(isRescuedFromOfflineQueue("tc1")).toBe(false)
  })

  it("rescues on a later try after a failed copy", async () => {
    leaderDead = true
    await enqueueOutboxEvent(commit("tc1", "p0"))
    setLeaderStalled(true)
    failIndexedDbWrites = true
    expect(await rescueUnpersistedOfflineWrites()).toBe(false)

    failIndexedDbWrites = false
    expect(await rescueUnpersistedOfflineWrites()).toBe(true)
    expect(await inIndexedDb()).toEqual(["tc1"])
    expect(journalLeft()).toEqual([])
  })

  it("still lets a leader that recovers after a failed copy clear the journal", async () => {
    leaderDead = true
    await enqueueOutboxEvent(commit("tc1", "p0"))
    setLeaderStalled(true)
    failIndexedDbWrites = true
    expect(await rescueUnpersistedOfflineWrites()).toBe(false)

    // Otherwise the next launch would replay an edit the leader already has.
    reviveLeader()
    expect(journalLeft()).toEqual([])
    failIndexedDbWrites = false
    expect(await rescueUnpersistedOfflineWrites()).toBe(true)
    expect(await inIndexedDb()).toEqual([])
  })

  it("doesn't report everything safe while another rescue's copy is still failing", async () => {
    leaderDead = true
    await enqueueOutboxEvent(commit("tc1", "p0"))
    setLeaderStalled(true)
    failIndexedDbWrites = true

    const [first, second] = await Promise.all([rescueUnpersistedOfflineWrites(), rescueUnpersistedOfflineWrites()])
    expect([first, second]).toEqual([false, false])
    expect(journalLeft()).toEqual(["aquilla:outbox-recovery:v1:tc1"])
  })
})
