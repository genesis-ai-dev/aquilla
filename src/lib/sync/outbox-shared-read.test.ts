// AQU-2655. WHY: about eight hooks re-read the outbox on every notification.
// Each read was its own IndexedDB scan that settled in its own task, so one
// acked commit rendered the project workspace once per reader. The shared read
// makes one notification one scan whose readers all resume together — but it
// must never hand a caller rows read before a write that caller is reacting to.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  holdOutboxNotifications,
  peekOutboxShared,
  removeOutboxEvents,
  resetOutboxConnectionForTests,
  subscribeToOutbox,
} from "./outbox"
import { CQRS_SCHEMA_VERSION, type CqrsRawEvent } from "./outbox-types"

const event = (id: string): CqrsRawEvent<"target.cell.commit"> => ({
  id,
  schemaVersion: CQRS_SCHEMA_VERSION,
  kind: "target.cell.commit",
  projectId: "p",
  fileId: "f",
  cellId: id,
  author: "a",
  payload: { value: "x", valueHtml: "<p>x</p>" },
  clientTs: 1,
})

/** Counts outbox scans: every peek opens one cursor on the enqueuedAt index. */
function countScans() {
  return vi.spyOn(IDBIndex.prototype, "openCursor")
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe("peekOutboxShared", () => {
  it("answers every subscriber of one notification from one scan", async () => {
    const seen: string[][] = []
    const reads: Promise<void>[] = []
    const reader = () => {
      reads.push(peekOutboxShared(1000).then((rows) => { seen.push(rows.map((r) => r.id)) }))
    }
    const unsubs = [0, 1, 2].map(() => subscribeToOutbox(() => reader()))
    try {
      const scans = countScans()
      await enqueueOutboxEvent(event("e1"))
      await Promise.all(reads)
      expect(seen).toEqual([["e1"], ["e1"], ["e1"]])
      expect(scans).toHaveBeenCalledTimes(1)
    } finally {
      for (const unsub of unsubs) unsub()
    }
  })

  it("does not reuse a read that began before a write", async () => {
    await enqueueOutboxEvent(event("e1"))
    // In flight and not awaited: it may or may not see e2.
    const before = peekOutboxShared(1000)
    await enqueueOutboxEvent(event("e2"))
    // Asked after the write: must see it, whatever the first read saw.
    const after = await peekOutboxShared(1000)
    expect(after.map((r) => r.id)).toEqual(["e1", "e2"])
    await before
  })

  it("does not reuse a read across a write whose notification is held", async () => {
    await enqueueOutboxEvent(event("e1"))
    const release = holdOutboxNotifications()
    try {
      const before = peekOutboxShared(1000)
      await removeOutboxEvents(["e1"])
      expect(await peekOutboxShared(1000)).toEqual([])
      await before
    } finally {
      release()
    }
  })

  it("reads again once a read has settled, so another tab's writes are seen", async () => {
    await enqueueOutboxEvent(event("e1"))
    const scans = countScans()
    await peekOutboxShared(1000)
    await peekOutboxShared(1000)
    expect(scans).toHaveBeenCalledTimes(2)
  })

  it("honours each caller's limit on the one shared read", async () => {
    await enqueueOutboxEvent(event("e1"))
    await enqueueOutboxEvent(event("e2"))
    await enqueueOutboxEvent(event("e3"))
    const scans = countScans()
    const [two, all] = await Promise.all([peekOutboxShared(2), peekOutboxShared(1000)])
    expect(two.map((r) => r.id)).toEqual(["e1", "e2"])
    expect(all.map((r) => r.id)).toEqual(["e1", "e2", "e3"])
    expect(scans).toHaveBeenCalledTimes(1)
  })
})
