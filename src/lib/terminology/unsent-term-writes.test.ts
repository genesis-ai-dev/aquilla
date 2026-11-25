import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppliedEventFrame } from "@/lib/sync/live-apply"
import type { OutboxRecord } from "@/lib/sync/outbox"
import type { RejectedEntry } from "@/lib/sync/outbox-flush"

// The flush and the outbox, reduced to the three things this module hears.
const heard = vi.hoisted(() => ({
  applied: new Set<(frames: AppliedEventFrame[]) => void>(),
  rejected: new Set<(entries: RejectedEntry[]) => void>(),
  outbox: new Set<() => void>(),
  records: [] as OutboxRecord[],
}))
vi.mock("@/lib/sync/outbox-flush", () => ({
  subscribeAppliedEvents: (fn: (frames: AppliedEventFrame[]) => void) => {
    heard.applied.add(fn)
    return () => heard.applied.delete(fn)
  },
  subscribeRejected: (fn: (entries: RejectedEntry[]) => void) => {
    heard.rejected.add(fn)
    return () => heard.rejected.delete(fn)
  },
}))
vi.mock("@/lib/sync/outbox", () => ({
  subscribeToOutbox: (fn: () => void) => {
    heard.outbox.add(fn)
    return () => heard.outbox.delete(fn)
  },
  getOutboxRecords: async (ids: readonly string[]) => heard.records.filter((record) => ids.includes(record.id)),
}))

import { hasUnsentTermWrites, noteTermWriteQueued } from "./unsent-term-writes"

const frame = (id: string) => ({ t: "event.applied", id, kind: "term.update", project: "p1" }) as AppliedEventFrame
const record = (id: string, status: OutboxRecord["status"]) => ({ id, status }) as OutboxRecord

beforeEach(() => {
  heard.records = []
})

// The glossary holds its own change over an arriving list for exactly as long
// as this says a write is unsent. Too short and the change flickers away; too
// long and the glossary stops following the server.
describe("unsent term writes", () => {
  it("holds a project from the moment a write is queued until the server takes it", () => {
    expect(hasUnsentTermWrites("p1")).toBe(false)
    noteTermWriteQueued("p1", "e1")
    noteTermWriteQueued("p1", "e2")
    expect(hasUnsentTermWrites("p1")).toBe(true)
    expect(hasUnsentTermWrites("p2")).toBe(false)

    for (const fn of heard.applied) fn([frame("e1")])
    expect(hasUnsentTermWrites("p1")).toBe(true)
    for (const fn of heard.applied) fn([frame("e2")])
    expect(hasUnsentTermWrites("p1")).toBe(false)
  })

  it("lets go of a write the server refused", () => {
    noteTermWriteQueued("p1", "e1")
    for (const fn of heard.rejected) fn([{ id: "e1", kind: "term.update", status: 403, reason: "no", fileId: null, cellId: null }])
    expect(hasUnsentTermWrites("p1")).toBe(false)
  })

  it("lets go of a write that left the outbox some other way, and keeps one still waiting", async () => {
    noteTermWriteQueued("p1", "gone")
    noteTermWriteQueued("p1", "set-aside")
    noteTermWriteQueued("p2", "waiting")
    heard.records = [record("set-aside", "failed"), record("waiting", "pending")]
    for (const fn of heard.outbox) fn()
    await vi.waitFor(() => expect(hasUnsentTermWrites("p1")).toBe(false))
    expect(hasUnsentTermWrites("p2")).toBe(true)
  })

  it("stops listening once nothing is unsent", () => {
    noteTermWriteQueued("p1", "e1")
    for (const fn of heard.applied) fn([frame("e1")])
    expect(heard.applied.size + heard.rejected.size + heard.outbox.size).toBe(0)
  })
})
