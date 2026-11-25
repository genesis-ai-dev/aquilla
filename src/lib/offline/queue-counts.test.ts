import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  forgetRescuedFromOfflineQueue,
  forgetStallRescueForTests,
  markRescuedFromOfflineQueue,
} from "@/lib/sync/offline-stall-rescue"
import { countOfflineQueue, useOfflineQueueCounts } from "./queue-counts"
import { events, schema } from "./schema"

afterEach(() => forgetStallRescueForTests())

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

describe("countOfflineQueue", () => {
  it("counts pending and failed rows, skipping rows rescued to IndexedDB", () => {
    markRescuedFromOfflineQueue([{ id: "r1", projectId: "proj1" }])
    expect(
      countOfflineQueue([
        { id: "a", status: "pending" },
        { id: "b", status: "flushing" },
        { id: "c", status: "failed" },
        { id: "r1", status: "pending" },
      ]),
    ).toEqual({ pending: 2, failed: 1 })
  })
})

describe("useOfflineQueueCounts", () => {
  it("re-counts when a queued row is rescued, and again when it's forgotten", async () => {
    const store: Store<typeof schema> = await createStorePromise({
      schema,
      storeId: "queue-counts-rescued",
      adapter: makeInMemoryAdapter(),
      disableDevtools: true,
      batchUpdates: (run) => run(),
    })
    store.commit(queued("q1"), queued("q2"))
    const { result } = renderHook(() => useOfflineQueueCounts(store, "proj1"))
    expect(result.current).toEqual({ pending: 2, failed: 0 })

    act(() => markRescuedFromOfflineQueue([{ id: "q2", projectId: "proj1" }]))
    expect(result.current).toEqual({ pending: 1, failed: 0 })

    act(() => forgetRescuedFromOfflineQueue(["q2"]))
    expect(result.current).toEqual({ pending: 2, failed: 0 })
  })
})
