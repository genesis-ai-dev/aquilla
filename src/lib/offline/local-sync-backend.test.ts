// Weeks offline must not mean weeks of events held in memory: the leader's
// `pending` list has to drain once a checkpoint is confirmed.
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startLocalCheckpoints } from "./local-checkpoint"
import { makeLocalSyncBackend } from "./local-sync-backend"
import { events, schema } from "./schema"

let storeSeq = 0
const stores: Store<typeof schema>[] = []

async function makeStore(withBackend: boolean): Promise<Store<typeof schema>> {
  storeSeq += 1
  const store = await createStorePromise({
    schema,
    storeId: `local-sync-backend-${storeSeq}`,
    adapter: makeInMemoryAdapter(withBackend ? { sync: { backend: makeLocalSyncBackend } } : {}),
  })
  stores.push(store)
  return store
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(stores.splice(0).map((s) => s.shutdownPromise()))
})

const leaderPending = async (store: Store<typeof schema>): Promise<number> =>
  (await store._dev.syncStates()).leader.pending.length

/** Leader pushes and the echo pull run on their own fibers. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

function commitClientEvents(store: Store<typeof schema>, count: number): void {
  for (let i = 0; i < count; i++) {
    store.commit(events.syncCursorSet({ projectId: "p1", fileId: `f${i}`, serverSeq: i, projectEpoch: 1 }))
  }
}

describe("local sync backend", () => {
  it("without it, client-only events stay pending in the leader forever (the bug)", async () => {
    const store = await makeStore(false)
    commitClientEvents(store, 50)
    store.commit(events.localCheckpoint({}))
    await waitFor(async () => (await leaderPending(store)) >= 51)
    await new Promise((r) => setTimeout(r, 200))
    expect(await leaderPending(store)).toBe(51)
  })

  it("a confirmed checkpoint drains every client event before it", async () => {
    const store = await makeStore(true)
    commitClientEvents(store, 50)
    await waitFor(async () => (await leaderPending(store)) === 50)

    store.commit(events.localCheckpoint({}))
    await waitFor(async () => (await leaderPending(store)) === 0)
    expect(store.syncStatus().isSynced).toBe(true)
  })

  it("keeps draining across repeated bursts", async () => {
    const store = await makeStore(true)
    for (let burst = 0; burst < 5; burst++) {
      commitClientEvents(store, 20)
      store.commit(events.localCheckpoint({}))
      await waitFor(async () => (await leaderPending(store)) === 0)
    }
    // Once a checkpoint is confirmed, later client events don't pile up at
    // all: LiveStore only holds them while no global event sits upstream.
    commitClientEvents(store, 3)
    await new Promise((r) => setTimeout(r, 200))
    expect(await leaderPending(store)).toBe(0)
  })
})

describe("startLocalCheckpoints", () => {
  it("checkpoints at start, then once per settled burst of writes", async () => {
    vi.useFakeTimers()
    const store = await makeStore(true)
    const commit = vi.spyOn(store, "commit")
    const stop = startLocalCheckpoints(store, { checkEveryMs: 1_000 })
    const checkpoints = () => commit.mock.calls.filter(([e]) => (e as { name: string }).name === "v1.LocalCheckpoint").length

    expect(checkpoints()).toBe(1) // boot: clears any backlog from an older build

    vi.advanceTimersByTime(3_000)
    expect(checkpoints()).toBe(1) // nothing written since

    commitClientEvents(store, 5)
    vi.advanceTimersByTime(1_000) // head moved this tick — still settling
    expect(checkpoints()).toBe(1)
    commitClientEvents(store, 5)
    vi.advanceTimersByTime(1_000) // moved again
    expect(checkpoints()).toBe(1)
    vi.advanceTimersByTime(1_000) // held still for a tick
    expect(checkpoints()).toBe(2)
    vi.advanceTimersByTime(5_000)
    expect(checkpoints()).toBe(2)
    stop()
  })
})
