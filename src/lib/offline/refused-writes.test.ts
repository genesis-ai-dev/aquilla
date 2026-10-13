import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { events, schema } from "./schema"
import {
  countRefusedWrites,
  discardRefusedWrites,
  retryRefusedWrites,
  subscribeToDiscardedOfflineCommits,
} from "./refused-writes"

let store: Store<typeof schema>
let storeId = 0

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `refused-writes-lib-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
})

function queueCommit(id: string, value: string, status: "pending" | "failed"): void {
  store.commit(
    events.eventQueued({
      id,
      projectId: "proj1",
      fileId: "file1",
      cellId: `cell-${id}`,
      kind: "target.cell.commit",
      payload: { value },
      parentId: "head-1",
      author: "dev@local.test",
      schemaVersion: 1,
      clientTs: new Date(),
      createdAt: new Date(),
    }),
  )
  if (status === "failed") store.commit(events.eventQueueStatusSet({ id, status }))
}

describe("subscribeToDiscardedOfflineCommits", () => {
  it("reports a refused commit once it's discarded", () => {
    queueCommit("q1", "refused text", "failed")
    const onDiscarded = vi.fn()
    const unsubscribe = subscribeToDiscardedOfflineCommits(store, "proj1", "file1", onDiscarded)

    discardRefusedWrites(store)

    expect(onDiscarded).toHaveBeenCalledExactlyOnceWith("cell-q1", "refused text")
    expect(countRefusedWrites(store)).toBe(0)
    unsubscribe()
  })

  it("ignores Retry and writes the server accepted", () => {
    queueCommit("q1", "refused text", "failed")
    queueCommit("q2", "pending text", "pending")
    const onDiscarded = vi.fn()
    const unsubscribe = subscribeToDiscardedOfflineCommits(store, "proj1", "file1", onDiscarded)

    retryRefusedWrites(store)
    store.commit(events.eventDequeued({ id: "q1" }))
    store.commit(events.eventDequeued({ id: "q2" }))

    expect(onDiscarded).not.toHaveBeenCalled()
    unsubscribe()
  })
})
