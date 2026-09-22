import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "fake-indexeddb/auto"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import {
  schema as offlineSchema,
  tables as offlineTables,
  events as offlineEvents,
} from "@/lib/offline/schema"
import {
  enqueueOutboxEvent,
  enqueueOutboxEvents,
  markOutboxAttempt,
  peekOutboxBatch,
  removeOutboxEvents,
  outboxPendingCount,
  outboxFailedCount,
  peekPendingOutboxBatch,
  getOutboxRecordsForCell,
  quarantineOutboxEvents,
  acknowledgeOutboxEvents,
  requeueOutboxEvents,
  resetOutboxConnectionForTests,
  OUTBOX_MAX_ATTEMPTS,
  requeueTransientlyFailedOutboxEvents,
  stampOutboxError,
  subscribeToOutbox,
  setActiveOutboxOwner,
  claimLegacyOutboxEvents,
  outboxRecordCountAllOwners,
} from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"
import { CQRS_SCHEMA_VERSION } from "./outbox-types"
import { flushOutboxBatch } from "./outbox-flush"
import { journalTargetCommit } from "./outbox-recovery"

// ── Tauri offline routing (Phase 4) test harness ───────────────────────────
// outbox.ts dynamically `import()`s "@/lib/offline/store" only when
// isTauriRuntime() is true (kept out of its static imports so the plain
// browser SPA bundle never pulls in LiveStore/OPFS/wa-sqlite — see
// src/lib/offline/is-tauri.ts). We mock that module to hand back a real,
// in-memory LiveStore store (same pattern as sync-adapter.test.ts /
// store.test.ts) instead of booting the real worker-backed OPFS adapter,
// which isn't available under Vitest.
let currentOfflineStore: Store<typeof offlineSchema> | undefined
const getOfflineStoreMock = vi.fn(async () => {
  if (!currentOfflineStore) throw new Error("test: offline store not initialized")
  return currentOfflineStore
})
vi.mock("@/lib/offline/store", () => ({
  getOfflineStore: () => getOfflineStoreMock(),
}))

function setTauriRuntime(on: boolean): void {
  const w = window as unknown as { __TAURI__?: object }
  if (on) w.__TAURI__ = {}
  else delete w.__TAURI__
}

describe("cqrs outbox", () => {
  const sample: CqrsRawEvent<"target.cell.commit"> = {
    id: "e1",
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: "p",
    fileId: "f",
    cellId: "c",
    author: "a",
    payload: { value: "x", valueHtml: "<p>x</p>" },
    clientTs: 1,
  }

  beforeEach(async () => {
    localStorage.clear()
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("enqueue, peek, remove", async () => {
    expect(await outboxPendingCount()).toBe(0)
    await enqueueOutboxEvent(sample)
    expect(await outboxPendingCount()).toBe(1)
    const peek = await peekOutboxBatch(10)
    expect(peek).toHaveLength(1)
    expect(peek[0].event.id).toBe("e1")
    expect(peek[0].attempts).toBe(0)
    expect(peek[0].lastAttemptAt).toBe(null)
    expect(peek[0].lastError).toBe(null)
    await removeOutboxEvents(["e1"])
    expect(await outboxPendingCount()).toBe(0)
  })

  it("journals a target commit synchronously before IndexedDB can finish", async () => {
    setActiveOutboxOwner("alice")
    const pending = enqueueOutboxEvent(sample)
    const key = "aquilla:outbox-recovery:v1:e1"
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      ownerKey: "alice", event: { id: "e1", payload: sample.payload },
    })
    await pending
    expect(localStorage.getItem(key)).toBeNull()
    expect(await outboxPendingCount()).toBe(1)
  })

  it("recovers a write interrupted before IDB without crossing account boundaries", async () => {
    journalTargetCommit({
      id: sample.id, event: sample, ownerKey: "alice", enqueuedAt: 1,
      attempts: 0, lastAttemptAt: null, lastError: null, status: "pending",
    })
    setActiveOutboxOwner("bob")
    expect(await peekOutboxBatch(10)).toEqual([])
    setActiveOutboxOwner("alice")
    const recovered = await peekOutboxBatch(10)
    expect(recovered).toHaveLength(1)
    expect(recovered[0].event).toEqual(sample)
    expect(localStorage.getItem("aquilla:outbox-recovery:v1:e1")).toBeNull()
  })

  it("does not replace a quarantined event when replaying a stale journal", async () => {
    setActiveOutboxOwner("alice")
    await enqueueOutboxEvent(sample)
    await quarantineOutboxEvents([sample.id], { status: 403, reason: "forbidden" })
    const [existing] = await peekOutboxBatch(10)
    journalTargetCommit({ ...existing, status: "pending", attempts: 0, lastError: null })
    await resetOutboxConnectionForTests()
    setActiveOutboxOwner("alice")
    const [recovered] = await peekOutboxBatch(10)
    expect(recovered.status).toBe("failed")
    expect(recovered.lastError).toEqual({ status: 403, reason: "forbidden" })
  })

  it("keeps each account's durable queue isolated across switches", async () => {
    setActiveOutboxOwner("alice")
    await enqueueOutboxEvent(sample)
    expect(await outboxPendingCount()).toBe(1)

    setActiveOutboxOwner("bob")
    expect(await outboxPendingCount()).toBe(0)
    expect(await peekPendingOutboxBatch(10)).toEqual([])
    await enqueueOutboxEvent({ ...sample, id: "bob-event", author: "bob" })
    expect((await peekOutboxBatch(10)).map((record) => record.id)).toEqual(["bob-event"])

    setActiveOutboxOwner("alice")
    expect((await peekOutboxBatch(10)).map((record) => record.id)).toEqual(["e1"])
  })

  it("supports explicit background reads and owner-guarded mutations without changing the active account", async () => {
    setActiveOutboxOwner("alice")
    await enqueueOutboxEvent(sample)
    setActiveOutboxOwner("bob")
    await enqueueOutboxEvent({ ...sample, id: "bob-event", author: "bob" })

    expect((await peekPendingOutboxBatch(10, { ownerKey: "alice" })).map((record) => record.id)).toEqual(["e1"])
    expect((await peekPendingOutboxBatch(10)).map((record) => record.id)).toEqual(["bob-event"])

    // A stale/malicious acknowledgement for Alice cannot mutate Bob's row.
    await removeOutboxEvents(["bob-event"], { ownerKey: "alice" })
    await markOutboxAttempt(["bob-event"], {
      error: { status: 500, reason: "wrong owner" },
    }, { ownerKey: "alice" })

    const bob = await peekOutboxBatch(10)
    expect(bob).toHaveLength(1)
    expect(bob[0].attempts).toBe(0)
    expect(await outboxPendingCount({ ownerKey: "alice" })).toBe(1)
  })

  it("keeps an enqueue in the owner scope that initiated it", async () => {
    setActiveOutboxOwner("alice")
    const enqueuing = enqueueOutboxEvent(sample)
    setActiveOutboxOwner("bob")
    await enqueuing

    expect(await peekOutboxBatch(10)).toEqual([])
    setActiveOutboxOwner("alice")
    expect((await peekOutboxBatch(10)).map((record) => record.id)).toEqual(["e1"])
  })

  it("claims unresolved pre-hydration edits for the first resolved owner", async () => {
    await enqueueOutboxEvent(sample)
    setActiveOutboxOwner("alice")
    expect(await peekOutboxBatch(10)).toEqual([])

    await claimLegacyOutboxEvents("alice")
    expect((await peekOutboxBatch(10)).map((record) => record.id)).toEqual(["e1"])
  })

  it("counts inactive account records for sign-out-all warnings", async () => {
    setActiveOutboxOwner("alice")
    await enqueueOutboxEvent(sample)
    setActiveOutboxOwner("bob")
    await enqueueOutboxEvent({ ...sample, id: "bob-event", author: "bob" })

    expect(await outboxPendingCount()).toBe(1)
    expect(await outboxRecordCountAllOwners()).toBe(2)
  })

  it("reads every durable outbox event scoped to one cell", async () => {
    await enqueueOutboxEvent(sample)
    await enqueueOutboxEvent({ ...sample, id: "other-cell", cellId: "other" })
    await enqueueOutboxEvent({ ...sample, id: "other-file", fileId: "other" })

    const records = await getOutboxRecordsForCell("p", "f", "c")
    expect(records.map((record) => record.id)).toEqual(["e1"])
  })

  it("markOutboxAttempt records attempts and lastError on existing rows", async () => {
    await enqueueOutboxEvent(sample)
    await markOutboxAttempt(["e1"], {
      error: { status: 401, reason: "token expired" },
      at: 1700,
    })
    const peek = await peekOutboxBatch(10)
    expect(peek[0].attempts).toBe(1)
    expect(peek[0].lastAttemptAt).toBe(1700)
    expect(peek[0].lastError).toEqual({ status: 401, reason: "token expired" })

    // Subsequent attempt bumps the counter and overwrites lastError.
    await markOutboxAttempt(["e1"], {
      error: { status: 403, reason: "role too low" },
      at: 1800,
    })
    const peek2 = await peekOutboxBatch(10)
    expect(peek2[0].attempts).toBe(2)
    expect(peek2[0].lastError).toEqual({ status: 403, reason: "role too low" })
  })

  it("markOutboxAttempt is a no-op for ids not in the store", async () => {
    await enqueueOutboxEvent(sample)
    await markOutboxAttempt(["does-not-exist"], {
      error: { status: 500, reason: "boom" },
    })
    const peek = await peekOutboxBatch(10)
    // Original record is untouched.
    expect(peek[0].attempts).toBe(0)
    expect(peek[0].lastError).toBe(null)
  })

  it("flushOutboxBatch records auth quarantine on 401 rejected rows", async () => {
    await enqueueOutboxEvent(sample)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: [],
          rejected: [{ id: "e1", status: 401, reason: "unauth" }],
        }),
        { status: 200 },
      ),
    )
    await flushOutboxBatch({
      getTokenForFile: async () => ({ token: "tok", status: 200 }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    // The 401-rejected event stays in the outbox (auth quarantine).
    expect(await outboxPendingCount()).toBe(1)
    const peek = await peekOutboxBatch(10)
    expect(peek[0].attempts).toBe(1)
    expect(peek[0].lastError).toEqual({ status: 401, reason: "unauth" })
  })

  it("flushOutboxBatch POSTs and removes accepted rows", async () => {
    await enqueueOutboxEvent(sample)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: [{ id: "e1" }], rejected: [] }), {
        status: 200,
      }),
    )
    await flushOutboxBatch({
      getTokenForFile: async () => ({ token: "tok", status: 200 }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain("/events")
    expect(init.method).toBe("POST")
    expect(await outboxPendingCount()).toBe(0)
  })

  it("failure cap: record transitions to `failed` after OUTBOX_MAX_ATTEMPTS", async () => {
    await enqueueOutboxEvent(sample)
    const initialPeek = await peekOutboxBatch(10)
    expect(initialPeek[0].status).toBe("pending")

    // Mark attempts up to (but not reaching) the cap — status stays pending.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS - 1; i++) {
      await markOutboxAttempt(["e1"], { error: { status: 500, reason: "server error" } })
    }
    const beforeCap = await peekOutboxBatch(10)
    expect(beforeCap[0].status).toBe("pending")
    expect(beforeCap[0].attempts).toBe(OUTBOX_MAX_ATTEMPTS - 1)

    // One more attempt hits the cap.
    await markOutboxAttempt(["e1"], { error: { status: 500, reason: "server error" } })
    const afterCap = await peekOutboxBatch(10)
    expect(afterCap[0].status).toBe("failed")
    expect(afterCap[0].attempts).toBe(OUTBOX_MAX_ATTEMPTS)

    // outboxFailedCount reflects the transition.
    expect(await outboxFailedCount()).toBe(1)
    // The total count still includes the failed record.
    expect(await outboxPendingCount()).toBe(1)
  })

  it("peekPendingOutboxBatch excludes failed records", async () => {
    await enqueueOutboxEvent(sample)
    const sample2: CqrsRawEvent<"target.cell.commit"> = { ...sample, id: "e2" }
    await enqueueOutboxEvent(sample2)

    // Cap e1 to failed.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await markOutboxAttempt(["e1"], { error: { status: 500, reason: "err" } })
    }

    const pending = await peekPendingOutboxBatch(10)
    expect(pending.map((r) => r.id)).toEqual(["e2"])
  })

  // ── RES-2: requeueTransientlyFailedOutboxEvents ────────────────────────────

  it("requeueTransientlyFailedOutboxEvents revives status-0 failed records back to pending", async () => {
    await enqueueOutboxEvent(sample)
    // Simulate a transient failure that was stamped (no budget burn) but
    // somehow the record ends up in `failed` state (e.g. from a prior version
    // that used markOutboxAttempt for network errors).
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await markOutboxAttempt(["e1"], { error: { status: 0, reason: "network error" } })
    }
    const beforeRevive = await peekOutboxBatch(10)
    expect(beforeRevive[0].status).toBe("failed")

    await requeueTransientlyFailedOutboxEvents()

    const afterRevive = await peekOutboxBatch(10)
    expect(afterRevive[0].status).toBe("pending")
    expect(afterRevive[0].attempts).toBe(0)
    expect(afterRevive[0].lastError).toBe(null)
  })

  it("requeueTransientlyFailedOutboxEvents revives 5xx-failed records but leaves 4xx quarantines", async () => {
    await enqueueOutboxEvent(sample)
    const sample2: CqrsRawEvent<"target.cell.commit"> = { ...sample, id: "e2" }
    await enqueueOutboxEvent(sample2)

    // e1: simulate 5xx failures hitting cap (transient)
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await markOutboxAttempt(["e1"], { error: { status: 503, reason: "service unavailable" } })
    }
    // e2: quarantined by 403 (permanent)
    await quarantineOutboxEvents(["e2"], { status: 403, reason: "forbidden" })

    const beforeRevive = await peekOutboxBatch(10)
    expect(beforeRevive.find(r => r.id === "e1")?.status).toBe("failed")
    expect(beforeRevive.find(r => r.id === "e2")?.status).toBe("failed")

    await requeueTransientlyFailedOutboxEvents()

    const afterRevive = await peekOutboxBatch(10)
    // e1 (5xx) should be revived.
    expect(afterRevive.find(r => r.id === "e1")?.status).toBe("pending")
    // e2 (403) should remain failed — 4xx quarantines must survive reconnect.
    expect(afterRevive.find(r => r.id === "e2")?.status).toBe("failed")
  })

  it("requeueTransientlyFailedOutboxEvents is a no-op when there are no failed records", async () => {
    await enqueueOutboxEvent(sample)
    // e1 is pending, not failed.
    await requeueTransientlyFailedOutboxEvents()
    const rows = await peekOutboxBatch(10)
    expect(rows[0].status).toBe("pending")
  })

  it("stampOutboxError does NOT increment attempts (used for transient failures)", async () => {
    await enqueueOutboxEvent(sample)
    await stampOutboxError(["e1"], { status: 0, reason: "network error" })
    const rows = await peekOutboxBatch(10)
    expect(rows[0].attempts).toBe(0) // never bumped
    expect(rows[0].lastError).toMatchObject({ status: 0, reason: "network error" })
    expect(rows[0].status).toBe("pending") // still pending
  })

  // AQU-274: quarantineOutboxEvents immediately sets status=failed without
  // burning the full retry budget. peekOutboxBatch still returns the quarantined
  // record (inspector visibility); peekPendingOutboxBatch excludes it so the
  // flusher skips it.
  it("quarantineOutboxEvents immediately moves records to failed status", async () => {
    await enqueueOutboxEvent(sample)
    const initial = await peekOutboxBatch(10)
    expect(initial[0].status).toBe("pending")

    await quarantineOutboxEvents(["e1"], { status: 403, reason: "forbidden" })

    // peekOutboxBatch includes the failed record (inspector visibility).
    const all = await peekOutboxBatch(10)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe("failed")
    expect(all[0].lastError).toEqual({ status: 403, reason: "forbidden" })

    // peekPendingOutboxBatch excludes it so the flusher advances past it.
    const pending = await peekPendingOutboxBatch(10)
    expect(pending).toHaveLength(0)

    // outboxFailedCount reflects the quarantine.
    expect(await outboxFailedCount()).toBe(1)
  })

  // ── enqueueOutboxEvents (bulk) ─────────────────────────────────────────────

  function ev(id: string, cellId: string): CqrsRawEvent {
    return {
      id, schemaVersion: 1, kind: "target.cell.commit",
      projectId: "p1", fileId: "f1", cellId, parentId: "src1",
      author: "u1", payload: { value: `v-${cellId}` }, clientTs: 1,
    } as unknown as CqrsRawEvent
  }

  it("enqueueOutboxEvents writes all events and fires exactly one change notification", async () => {
    let notifications = 0
    const unsub = subscribeToOutbox(() => { notifications++ })
    await enqueueOutboxEvents([ev("e1", "c1"), ev("e2", "c2"), ev("e3", "c3")])
    unsub()
    const rows = await peekOutboxBatch(100)
    expect(rows.map((r) => r.id).sort()).toEqual(["e1", "e2", "e3"])
    expect(notifications).toBe(1)
  })

  it("enqueueOutboxEvents is idempotent on duplicate ids (same-id put overwrites)", async () => {
    await enqueueOutboxEvents([ev("dup", "c1")])
    await enqueueOutboxEvents([ev("dup", "c1")])
    const rows = await peekOutboxBatch(100)
    expect(rows.filter((r) => r.id === "dup")).toHaveLength(1)
  })

  // ── SUB-8: persistent banner acknowledgment ───────────────────────────────

  it("acknowledgeOutboxEvents stamps acknowledgedAt, keeps the record, and notifies", async () => {
    await enqueueOutboxEvent(sample)
    await quarantineOutboxEvents(["e1"], { status: 403, reason: "self-validation is not allowed on this project" })

    const notified = vi.fn()
    const unsub = subscribeToOutbox(notified)
    await acknowledgeOutboxEvents(["e1"])
    unsub()

    expect(notified).toHaveBeenCalled()
    const rec = (await peekOutboxBatch(10)).find((r) => r.id === "e1")
    // Non-destructive: still failed, error preserved, just acknowledged.
    expect(rec?.status).toBe("failed")
    expect(rec?.lastError?.status).toBe(403)
    expect(rec?.acknowledgedAt).toBeTypeOf("number")
  })

  it("requeueOutboxEvents clears acknowledgedAt so a re-refused change banners again", async () => {
    await enqueueOutboxEvent(sample)
    await quarantineOutboxEvents(["e1"], { status: 403, reason: "forbidden" })
    await acknowledgeOutboxEvents(["e1"])

    await requeueOutboxEvents(["e1"])

    const rec = (await peekOutboxBatch(10)).find((r) => r.id === "e1")
    expect(rec?.status).toBe("pending")
    expect(rec?.acknowledgedAt).toBeUndefined()
  })

  it("acknowledgeOutboxEvents is a no-op for unknown ids and empty input", async () => {
    await acknowledgeOutboxEvents([])
    await acknowledgeOutboxEvents(["nope"])
    expect(await peekOutboxBatch(10)).toHaveLength(0)
  })
})

// ── Tauri desktop offline routing (Phase 4) ────────────────────────────────
// enqueueOutboxEvent(s) routes target.cell.commit / cell.validate /
// cell.unvalidate into LiveStore's event_queue instead of IndexedDB, but only
// inside the Tauri runtime AND only for a project with a ready local copy.
describe("Tauri offline routing", () => {
  const commitEvent: CqrsRawEvent<"target.cell.commit"> = {
    id: "tc1",
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: "proj1",
    fileId: "file1",
    cellId: "cell1",
    parentId: "parent1",
    author: "dev@local.test",
    payload: { value: "hola" },
    clientTs: 12345,
  }

  function markProjectOfflineReady(projectId: string): void {
    currentOfflineStore!.commit(
      offlineEvents.offlineProjectStatusSet({
        projectId,
        status: "ready",
        syncedAt: new Date(),
        queueDepth: 0,
      }),
    )
  }

  beforeEach(async () => {
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
    currentOfflineStore = await createStorePromise({
      schema: offlineSchema,
      storeId: `outbox-offline-test-${Math.random().toString(36).slice(2)}`,
      adapter: makeInMemoryAdapter(),
      disableDevtools: true,
      batchUpdates: (run) => run(),
    })
    getOfflineStoreMock.mockClear()
    setTauriRuntime(false)
  })

  afterEach(() => {
    setTauriRuntime(false)
    currentOfflineStore = undefined
  })

  it("web build (isTauriRuntime false) is byte-for-byte unaffected: routable kinds still go to IndexedDB, offline store is never touched", async () => {
    await enqueueOutboxEvent(commitEvent)

    expect(getOfflineStoreMock).not.toHaveBeenCalled()
    expect(await outboxPendingCount()).toBe(1)
    expect(currentOfflineStore!.query(offlineTables.eventQueue.select())).toHaveLength(0)
  })

  it("routes target.cell.commit, cell.validate, and cell.unvalidate into event_queue when Tauri + offline-ready, and NOT into IndexedDB", async () => {
    setTauriRuntime(true)
    markProjectOfflineReady("proj1")

    await enqueueOutboxEvent(commitEvent)
    await enqueueOutboxEvent({
      ...commitEvent,
      id: "v1",
      kind: "cell.validate",
      payload: { editEventId: "tc1" },
    } as CqrsRawEvent<"cell.validate">)
    await enqueueOutboxEvent({
      ...commitEvent,
      id: "u1",
      kind: "cell.unvalidate",
      payload: { editEventId: "tc1" },
    } as CqrsRawEvent<"cell.unvalidate">)

    expect(await outboxPendingCount()).toBe(0)
    const rows = currentOfflineStore!.query(offlineTables.eventQueue.select())
    expect(rows.map((r) => r.id).sort()).toEqual(["tc1", "u1", "v1"])
  })

  it("falls through to IndexedDB when Tauri but the project is NOT offline-ready", async () => {
    setTauriRuntime(true)
    // No markProjectOfflineReady call — project has no "ready" row.

    await enqueueOutboxEvent(commitEvent)

    expect(await outboxPendingCount()).toBe(1)
    expect(currentOfflineStore!.query(offlineTables.eventQueue.select())).toHaveLength(0)
  })

  it("a non-routable kind always goes to IndexedDB regardless of Tauri/offline-ready state", async () => {
    setTauriRuntime(true)
    markProjectOfflineReady("proj1")

    const waiveEvent: CqrsRawEvent<"cell.waive"> = {
      id: "w1",
      schemaVersion: CQRS_SCHEMA_VERSION,
      kind: "cell.waive",
      projectId: "proj1",
      fileId: "file1",
      cellId: "cell1",
      parentId: null,
      author: "dev@local.test",
      payload: { ruleId: "rule1" },
      clientTs: 1,
    }
    await enqueueOutboxEvent(waiveEvent)

    expect(await outboxPendingCount()).toBe(1)
    // Non-routable kind never even triggers the offline-store import/check.
    expect(getOfflineStoreMock).not.toHaveBeenCalled()
    expect(currentOfflineStore!.query(offlineTables.eventQueue.select())).toHaveLength(0)
  })

  it("enqueueOutboxEvents partitions a mixed bulk batch between LiveStore and IndexedDB", async () => {
    setTauriRuntime(true)
    markProjectOfflineReady("proj1")

    const sourceCreate: CqrsRawEvent<"source.cell.create"> = {
      id: "sc1",
      schemaVersion: CQRS_SCHEMA_VERSION,
      kind: "source.cell.create",
      projectId: "proj1",
      fileId: "file1",
      cellId: "cell2",
      parentId: null,
      author: "dev@local.test",
      payload: { cellId: "cell2", value: "hi" },
      clientTs: 1,
    }
    let notifications = 0
    const unsub = subscribeToOutbox(() => { notifications++ })

    await enqueueOutboxEvents([commitEvent, sourceCreate])
    unsub()

    // Exactly one kind routed to LiveStore, the other fell through to one IDB write.
    expect(await outboxPendingCount()).toBe(1)
    expect(notifications).toBe(1)
    const idbRows = await peekOutboxBatch(10)
    expect(idbRows.map((r) => r.id)).toEqual(["sc1"])

    const queuedRows = currentOfflineStore!.query(offlineTables.eventQueue.select())
    expect(queuedRows.map((r) => r.id)).toEqual(["tc1"])
  })

  it("a routed row round-trips into the exact OutboxRawEvent shape sync-adapter.ts's toRawEvent() expects", async () => {
    setTauriRuntime(true)
    markProjectOfflineReady("proj1")

    await enqueueOutboxEvent(commitEvent)

    // Same query pattern sync-adapter.ts's flushQueue() uses.
    const row = currentOfflineStore!.query(
      offlineTables.eventQueue.select().where({ id: "tc1" }).first(),
    )
    expect(row).toBeTruthy()
    expect(row!.status).toBe("pending")

    // Mirrors sync-adapter.ts's private toRawEvent() exactly (fileId/cellId
    // null -> undefined, clientTs Date -> epoch ms) — proves the row this
    // module writes round-trips into a wire-valid OutboxRawEvent.
    const rebuilt = {
      id: row!.id,
      schemaVersion: row!.schemaVersion,
      kind: row!.kind,
      projectId: row!.projectId,
      fileId: row!.fileId ?? undefined,
      cellId: row!.cellId ?? undefined,
      parentId: row!.parentId,
      author: row!.author,
      payload: row!.payload,
      clientTs: row!.clientTs.getTime(),
    }
    expect(rebuilt).toEqual({
      id: "tc1",
      schemaVersion: CQRS_SCHEMA_VERSION,
      kind: "target.cell.commit",
      projectId: "proj1",
      fileId: "file1",
      cellId: "cell1",
      parentId: "parent1",
      author: "dev@local.test",
      payload: { value: "hola" },
      clientTs: 12345,
    })
  })
})
