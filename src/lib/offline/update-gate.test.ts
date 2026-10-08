import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { describe, expect, it } from "vitest"
import { events, schema } from "./schema"
import { addQueues, evaluateUpdateGate, readOfflineQueue } from "./update-gate"

let storeId = 0

async function makeStore(): Promise<Store<typeof schema>> {
  storeId += 1
  return createStorePromise({
    schema,
    storeId: `update-gate-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
}

const queued = (id: string) =>
  events.eventQueued({
    id,
    projectId: "proj1",
    fileId: "file1",
    cellId: "GEN 1:1",
    kind: "target.cell.commit",
    payload: { text: "En el principio" },
    parentId: null,
    author: "dev@local.test",
    schemaVersion: 1,
    clientTs: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
  })

describe("readOfflineQueue", () => {
  it("counts rows in every status and the failed ones separately", async () => {
    const store = await makeStore()
    expect(readOfflineQueue(store)).toEqual({ count: 0, failed: 0 })

    store.commit(queued("q1"), queued("q2"), queued("q3"))
    store.commit(events.eventQueueStatusSet({ id: "q2", status: "flushing" }))
    store.commit(events.eventQueueStatusSet({ id: "q3", status: "failed" }))
    expect(readOfflineQueue(store)).toEqual({ count: 3, failed: 1 })
  })
})

describe("evaluateUpdateGate", () => {
  it("is clear only when nothing is queued", () => {
    expect(evaluateUpdateGate({ count: 0, failed: 0 }, false)).toEqual({ kind: "clear" })
    expect(evaluateUpdateGate({ count: 0, failed: 0 }, true)).toEqual({ kind: "clear" })
  })

  it("waits while the queue is still sending", () => {
    expect(evaluateUpdateGate({ count: 2, failed: 0 }, false)).toEqual({ kind: "sending", count: 2 })
  })

  it("is stuck once the grace period is over", () => {
    expect(evaluateUpdateGate({ count: 2, failed: 0 }, true)).toEqual({ kind: "stuck", count: 2 })
  })

  it("is stuck straight away when a row has failed, since it won't be retried", () => {
    expect(evaluateUpdateGate({ count: 2, failed: 1 }, false)).toEqual({ kind: "stuck", count: 2 })
  })

  it("is unknown when the offline store couldn't be read", () => {
    expect(evaluateUpdateGate(null, false)).toEqual({ kind: "unknown" })
  })
})

describe("addQueues", () => {
  it("sums both counts", () => {
    expect(addQueues({ count: 2, failed: 1 }, { count: 3, failed: 0 })).toEqual({ count: 5, failed: 1 })
  })
})
